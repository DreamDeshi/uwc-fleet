/**
 * Consignee coordinate SELF-HEALING from driver GPS.
 *
 * A consignee whose address the Google geocoder could not place (latitude IS
 * NULL — a coarse zone-fallback stop) can still be pinned from where trucks
 * actually STOP to deliver to it. When enough INDEPENDENT trips agree on a spot,
 * that spot IS the building.
 *
 * This script is OFFLINE and additive. It NEVER overwrites an existing
 * coordinate (fill-nulls-only, enforced at write time by a full-pair
 * `latitude: null, longitude: null` guard), NEVER touches money, and writes
 * `geocode_match_type = "driver_fix"` so a healed pin is always distinguishable
 * from a Google one. A healed coordinate is a delivery position, exactly like a
 * Google ROOFTOP pin — it does NOT feed the rate tier (peak/off-peak keys on
 * `delivered_at`) and does NOT set `arrived_at`.
 *
 * ── Candidate extraction: at most ONE fix per (consignee, trip) ──────────────
 * Every delivered TripStop offers its nearest-in-time driver LocationLog fix
 * (within `window_min` of `delivered_at`). A single consignee can have SEVERAL
 * delivered stops on the SAME trip; those must not each count as independent
 * evidence. So for each (consignee_id, trip_id) group we evaluate every stop's
 * eligible fix and keep only the ONE with the smallest delivery-time difference.
 * The result is a single candidate per trip — three candidates therefore always
 * represent three DISTINCT trips.
 *
 * ── The clustering rule (conservative on purpose) ───────────────────────────
 * Per-trip candidates are clustered by a SEED-based method: a heal is written
 * only when some candidate (the "seed") has at least `min_fixes` candidates
 * within `radius_m` of it, drawn from at least `min_distinct_trips` DISTINCT
 * trips. The healed coordinate is the centroid of that winning cluster.
 *
 * ⚠ KNOWN FALSE-NEGATIVE LIMITATION: the seed-based method only considers
 * clusters ANCHORED at an actual candidate fix. A geometrically valid cluster
 * whose members are all near a common centroid but where no single member is
 * within `radius_m` of any OTHER single member (e.g. points spread around a ring
 * of diameter > radius_m) is NOT healed, even though their centroid is a good
 * estimate. This is deliberate and accepted: skipping a heal leaves the honest
 * zone-fallback in place, whereas writing an uncertain coordinate would put a
 * driver at a spot no single trip confirmed. A missed heal is safe; a wrong pin
 * is not.
 *
 * ── Dump = DECISIONS + EVIDENCE COUNTS ONLY (never raw GPS) ──────────────────
 * A dump records, per heal, only the DECISION (consignee, healed lat/lng) and
 * EVIDENCE COUNTS (n_fixes, n_trips) — plus top-level metadata (format /
 * algorithm version, timestamp, algorithm parameters). It contains NO individual
 * LocationLog coordinates and NO raw fixes: driver GPS traces never enter the
 * artifact. Consequently `--from` is NOT a self-contained replay. It:
 *   1. loads the saved decision + validates format/algorithm version + params;
 *   2. re-reads CURRENT TripStop + LocationLog evidence from the database;
 *   3. recomputes the ENTIRE candidate pipeline from that current evidence;
 *   4. compares the fresh centroid with the saved one;
 *   5. applies only heals that remain ELIGIBLE and land within `from_tolerance_m`.
 *
 * Flags:
 *   --dry-run          compute + summarise, write nothing to the DB
 *   --out <file>       dump per-heal DECISIONS + counts (no raw fixes)
 *   --from <file>      reconcile a prior dump against CURRENT DB evidence
 *   --window-min <n>        override window_min (default 5), positive finite
 *   --radius-m <n>          override radius_m (default 100), positive finite
 *   --from-tolerance-m <n>  override from_tolerance_m (default 10), positive finite
 *   (min_fixes=3 and min_distinct_trips=2 are LOCKED constants, not CLI flags)
 *   (writes are guarded to a LOCAL db unless ALLOW_REMOTE_DB=1)
 */
import { prisma } from "../src/lib/prisma";
import { dbHostOf, isLocalDbHost, isProdDbHost } from "../src/lib/dbGuard";

// ── Algorithm identity + parameters ──────────────────────────────────────────
// Bumping the algorithm in a way that changes results MUST bump
// `algorithm_version` (and, if the dump shape changes, `format_version`). That
// is what makes an old dump refuse to reconcile against new logic.
export const SUPPORTED_FORMAT_VERSION = 1;
export const SUPPORTED_ALGORITHM_VERSION = 1;

export interface AlgoParams {
  format_version: number;
  algorithm_version: number;
  /** Max minutes between a LocationLog fix and delivered_at for it to count. */
  window_min: number;
  /** Cluster radius, metres — a candidate is "at" a seed within this distance. */
  radius_m: number;
  /** Minimum per-trip candidates in the winning cluster. */
  min_fixes: number;
  /** Minimum DISTINCT trips those candidates must come from. */
  min_distinct_trips: number;
  /** Max allowed drift (m) between a fresh centroid and the saved one on --from. */
  from_tolerance_m: number;
}

export const ALGO: AlgoParams = {
  format_version: SUPPORTED_FORMAT_VERSION,
  algorithm_version: SUPPORTED_ALGORITHM_VERSION,
  window_min: 5,
  radius_m: 100,
  min_fixes: 3,
  min_distinct_trips: 2,
  from_tolerance_m: 10,
};

// ── Pure geometry ────────────────────────────────────────────────────────────
export interface Point {
  lat: number;
  lng: number;
}
export interface Fix extends Point {
  trip_id: string;
}

/**
 * Great-circle distance in METRES. Mirrors haversineKm() in src/lib/geo.ts
 * (kept inline so this script owns its own {lat,lng} shape and the pure tests
 * never pull the server geo module). Earth radius 6371 km.
 */
export function metersBetween(a: Point, b: Point): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Arithmetic mean position. Fine at building scale (sub-metre error). */
export function centroid(points: Point[]): Point {
  const n = points.length;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lng: points.reduce((s, p) => s + p.lng, 0) / n,
  };
}

// ── Candidate extraction (pure) ──────────────────────────────────────────────
export interface RawFix {
  lat: number;
  lng: number;
  recorded_at: Date;
}
export interface StopEvidence {
  trip_id: string;
  delivered_at: Date;
}

/**
 * The nearest-in-time fix to a delivery, provided its gap is within `window_min`.
 * Returns the fix plus that gap (ms), or null when no fix is close enough in time.
 */
export function nearestEligibleFix(
  deliveredAt: Date,
  tripFixes: RawFix[],
  windowMin: number,
): { lat: number; lng: number; gap_ms: number } | null {
  const windowMs = windowMin * 60_000;
  let best: { lat: number; lng: number; gap_ms: number } | null = null;
  for (const f of tripFixes) {
    const gap = Math.abs(f.recorded_at.getTime() - deliveredAt.getTime());
    if (gap <= windowMs && (best === null || gap < best.gap_ms)) {
      best = { lat: f.lat, lng: f.lng, gap_ms: gap };
    }
  }
  return best;
}

/**
 * The single candidate for ONE (consignee, trip): across every delivered stop of
 * that trip, take each stop's eligible fix and keep the one with the smallest
 * delivery-time difference. null = the trip contributes no evidence.
 */
export function tripCandidate(
  stops: StopEvidence[],
  tripFixes: RawFix[],
  windowMin: number,
): { lat: number; lng: number; gap_ms: number } | null {
  let best: { lat: number; lng: number; gap_ms: number } | null = null;
  for (const s of stops) {
    const near = nearestEligibleFix(s.delivered_at, tripFixes, windowMin);
    if (near && (best === null || near.gap_ms < best.gap_ms)) best = near;
  }
  return best;
}

/**
 * All per-trip candidates for one consignee: group its delivered stops by trip,
 * then emit AT MOST ONE Fix per trip. This is what guarantees N candidates ⇒ N
 * distinct trips.
 */
export function consigneeCandidates(
  stops: StopEvidence[],
  logsByTrip: Map<string, RawFix[]>,
  windowMin: number,
): Fix[] {
  const byTrip = new Map<string, StopEvidence[]>();
  for (const s of stops) {
    const arr = byTrip.get(s.trip_id) ?? [];
    arr.push(s);
    byTrip.set(s.trip_id, arr);
  }
  const out: Fix[] = [];
  for (const [trip_id, tripStops] of byTrip) {
    const c = tripCandidate(tripStops, logsByTrip.get(trip_id) ?? [], windowMin);
    if (c) out.push({ lat: c.lat, lng: c.lng, trip_id });
  }
  return out;
}

export interface HealResult extends Point {
  n_fixes: number;
  n_trips: number;
}

/**
 * The seed-based cluster heal. Returns the centroid of the strongest qualifying
 * cluster, or null when nothing qualifies (see the false-negative note above).
 *
 * Membership rule is INCLUSIVE of the radius: a candidate exactly `radius_m`
 * from the seed is a member (distance <= radius_m).
 */
export function clusterHeal(fixes: Fix[], p: AlgoParams = ALGO): HealResult | null {
  if (fixes.length < p.min_fixes) return null;

  let best: { members: Fix[]; trips: number } | null = null;
  for (const seed of fixes) {
    const members = fixes.filter((f) => metersBetween(seed, f) <= p.radius_m);
    const trips = new Set(members.map((m) => m.trip_id)).size;
    if (members.length >= p.min_fixes && trips >= p.min_distinct_trips) {
      // Strongest = most member fixes; ties keep the first seed (stable/deterministic).
      if (!best || members.length > best.members.length) best = { members, trips };
    }
  }
  if (!best) return null;

  const c = centroid(best.members);
  return { lat: c.lat, lng: c.lng, n_fixes: best.members.length, n_trips: best.trips };
}

// ── Dump shape (DECISIONS + COUNTS ONLY — no raw GPS) ─────────────────────────
export interface HealDecision {
  consignee_id: string;
  company_name: string;
  lat: number;
  lng: number;
  n_fixes: number; // evidence count only
  n_trips: number; // evidence count only
}

export interface Dump extends AlgoParams {
  generated_at: string;
  heals: HealDecision[];
}

/** A dump the running algorithm refuses to reconcile. */
export class DumpRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpRejected";
  }
}

export function buildDump(decisions: HealDecision[], params: AlgoParams = ALGO): Dump {
  return {
    format_version: params.format_version,
    algorithm_version: params.algorithm_version,
    generated_at: new Date().toISOString(),
    window_min: params.window_min,
    radius_m: params.radius_m,
    min_fixes: params.min_fixes,
    min_distinct_trips: params.min_distinct_trips,
    from_tolerance_m: params.from_tolerance_m,
    // Decisions carry only counts — never coordinates of individual fixes.
    heals: decisions.map((d) => ({
      consignee_id: d.consignee_id,
      company_name: d.company_name,
      lat: d.lat,
      lng: d.lng,
      n_fixes: d.n_fixes,
      n_trips: d.n_trips,
    })),
  };
}

/**
 * Reject a dump whose format/algorithm version is unsupported, or whose recorded
 * algorithm parameters differ from the ones we would recompute with. This is the
 * gate that stops a dump made by a different algorithm from being reconciled.
 */
export function validateDump(dump: Partial<Dump>, params: AlgoParams = ALGO): void {
  if (dump.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new DumpRejected(
      `unsupported format_version ${dump.format_version} (supported: ${SUPPORTED_FORMAT_VERSION})`,
    );
  }
  if (dump.algorithm_version !== SUPPORTED_ALGORITHM_VERSION) {
    throw new DumpRejected(
      `unsupported algorithm_version ${dump.algorithm_version} (supported: ${SUPPORTED_ALGORITHM_VERSION})`,
    );
  }
  const paramKeys: (keyof AlgoParams)[] = [
    "window_min",
    "radius_m",
    "min_fixes",
    "min_distinct_trips",
    "from_tolerance_m",
  ];
  for (const k of paramKeys) {
    if (dump[k] !== params[k]) {
      throw new DumpRejected(
        `parameter mismatch: dump.${k}=${dump[k]} but recomputation uses ${params[k]}`,
      );
    }
  }
}

// ── Recomputed evidence (fresh from the DB) ──────────────────────────────────
// A candidate carries the fresh decision PLUS the consignee's CURRENT stored
// coordinates, so the write layer can enforce fill-nulls-only atomically.
export interface Candidate {
  consignee_id: string;
  company_name: string;
  lat: number;
  lng: number;
  n_fixes: number;
  n_trips: number;
  current_latitude: number | null;
  current_longitude: number | null;
}

export interface WriteRow {
  consignee_id: string;
  lat: number;
  lng: number;
  current_latitude: number | null;
  current_longitude: number | null;
}

/**
 * --from reconciliation (pure): validate the dump, then for each saved decision
 * find the freshly-recomputed candidate for the same consignee and apply it only
 * if it is still eligible (present in `fresh`) and its centroid is within
 * `from_tolerance_m` of the saved one. Returns the write rows to apply plus the
 * consignees skipped as no-longer-eligible or drifted.
 */
export function reconcileFromDump(
  dump: Dump,
  fresh: Candidate[],
  params: AlgoParams = ALGO,
): { rows: WriteRow[]; ineligible: string[]; drifted: string[] } {
  validateDump(dump, params); // throws DumpRejected on version/param mismatch
  const byId = new Map(fresh.map((f) => [f.consignee_id, f]));
  const rows: WriteRow[] = [];
  const ineligible: string[] = [];
  const drifted: string[] = [];
  for (const saved of dump.heals) {
    const f = byId.get(saved.consignee_id);
    if (!f) {
      ineligible.push(saved.consignee_id); // no longer clusters under current evidence
      continue;
    }
    const drift = metersBetween({ lat: f.lat, lng: f.lng }, { lat: saved.lat, lng: saved.lng });
    if (drift > params.from_tolerance_m) {
      drifted.push(saved.consignee_id);
      continue;
    }
    // Approved decision is the saved centroid; the fresh recompute only GATES it.
    rows.push({
      consignee_id: saved.consignee_id,
      lat: saved.lat,
      lng: saved.lng,
      current_latitude: f.current_latitude,
      current_longitude: f.current_longitude,
    });
  }
  return { rows, ineligible, drifted };
}

// ── Persistence (client injected so it is unit-testable without a live DB) ───
export interface HealClient {
  consignee: {
    updateMany(args: {
      where: { id: string; latitude: null; longitude: null };
      data: { latitude: number; longitude: number; geocode_match_type: string };
    }): Promise<{ count: number }>;
  };
}

export interface ApplyResult {
  written: number;
  skipped_existing: number; // already fully geocoded
  skipped_partial: number; // exactly one coordinate present — anomaly, never touched
  skipped_race: number; // both null at read, but the guarded update matched 0 rows
}

/**
 * Write heals, fill-nulls-only. A consignee is written ONLY when BOTH stored
 * coordinates are null. A record with exactly ONE coordinate present is a
 * partial-coordinate anomaly and is NEVER modified — the write operation is not
 * even called for it. The DB update carries the same full-pair guard
 * (`latitude: null, longitude: null`) so a coordinate set after this read can
 * never be clobbered.
 */
export async function applyHeals(client: HealClient, rows: WriteRow[]): Promise<ApplyResult> {
  const res: ApplyResult = { written: 0, skipped_existing: 0, skipped_partial: 0, skipped_race: 0 };
  for (const r of rows) {
    const hasLat = r.current_latitude !== null;
    const hasLng = r.current_longitude !== null;
    if (hasLat || hasLng) {
      // Not fully-null → do NOT call the write operation.
      if (hasLat && hasLng) res.skipped_existing++;
      else res.skipped_partial++; // exactly one present: partial-coordinate anomaly
      continue;
    }
    const w = await client.consignee.updateMany({
      where: { id: r.consignee_id, latitude: null, longitude: null },
      data: { latitude: r.lat, longitude: r.lng, geocode_match_type: "driver_fix" },
    });
    if (w.count > 0) res.written++;
    else res.skipped_race++;
  }
  return res;
}

// ── DB → candidates (needs a live DB; exercised via integration) ─────────────
async function computeHeals(params: AlgoParams): Promise<Candidate[]> {
  // Only null-latitude consignees are candidates. We also read longitude so a
  // partial-coordinate anomaly (lat null / lng set) is carried to the guard.
  const consignees = await prisma.consignee.findMany({
    where: { latitude: null },
    select: { id: true, company_name: true, latitude: true, longitude: true },
  });
  const byId = new Map(consignees.map((c) => [c.id, c]));
  if (byId.size === 0) return [];

  const stops = await prisma.tripStop.findMany({
    where: { consignee_id: { in: [...byId.keys()] }, status: "delivered", delivered_at: { not: null } },
    select: { consignee_id: true, trip_id: true, delivered_at: true },
  });
  if (stops.length === 0) return [];

  const tripIds = [...new Set(stops.map((s) => s.trip_id))];
  const logs = await prisma.locationLog.findMany({
    where: { trip_id: { in: tripIds } },
    select: { trip_id: true, latitude: true, longitude: true, recorded_at: true },
  });
  const logsByTrip = new Map<string, RawFix[]>();
  for (const l of logs) {
    const arr = logsByTrip.get(l.trip_id) ?? [];
    arr.push({ lat: Number(l.latitude), lng: Number(l.longitude), recorded_at: l.recorded_at });
    logsByTrip.set(l.trip_id, arr);
  }

  const stopsByConsignee = new Map<string, StopEvidence[]>();
  for (const s of stops) {
    if (!s.delivered_at) continue;
    const arr = stopsByConsignee.get(s.consignee_id) ?? [];
    arr.push({ trip_id: s.trip_id, delivered_at: s.delivered_at });
    stopsByConsignee.set(s.consignee_id, arr);
  }

  const out: Candidate[] = [];
  for (const [consignee_id, evidence] of stopsByConsignee) {
    const candidates = consigneeCandidates(evidence, logsByTrip, params.window_min);
    const result = clusterHeal(candidates, params);
    if (!result) continue;
    const c = byId.get(consignee_id)!;
    out.push({
      consignee_id,
      company_name: c.company_name,
      lat: result.lat,
      lng: result.lng,
      n_fixes: result.n_fixes,
      n_trips: result.n_trips,
      current_latitude: c.latitude,
      current_longitude: c.longitude,
    });
  }
  return out;
}

function argValue(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : "";
}

/**
 * Parse a numeric CLI override that must be a POSITIVE FINITE number.
 *
 * OMITTED entirely → the default (no error). Only an EXPLICITLY-supplied flag is
 * validated, and it is rejected — with a clear message — when its value is:
 *   - missing (flag is the last token);
 *   - empty ("");
 *   - the next CLI flag mistaken for the value (starts with "-");
 *   - non-numeric;
 *   - zero or negative;
 *   - NaN or Infinity.
 * Pure over an explicit argv so it is unit-testable without touching process.argv.
 */
export function parseNumericFlag(argv: string[], flag: string, defaultValue: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return defaultValue; // omitted → default
  const raw = argv[i + 1];
  if (raw === undefined || raw === "") {
    throw new Error(`${flag} requires a value (a positive finite number)`);
  }
  // A following token that is itself a flag ("--dry-run", "-5"→handled below by
  // sign) must not be swallowed as the value. Guard the flag form here.
  if (raw.startsWith("--")) {
    throw new Error(`${flag} requires a value but was followed by the flag "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} must be a finite number (got "${raw}")`);
  }
  if (n <= 0) {
    throw new Error(`${flag} must be a positive number greater than 0 (got ${n})`);
  }
  return n;
}

async function main() {
  const DRY_RUN = process.argv.includes("--dry-run");
  const OUT = argValue("--out");
  const FROM = argValue("--from");
  // CLI overrides — omitting a flag keeps the approved default (5 / 100 / 10);
  // an explicitly-supplied invalid value is rejected before any DB work.
  const params: AlgoParams = {
    ...ALGO,
    window_min: parseNumericFlag(process.argv, "--window-min", ALGO.window_min),
    radius_m: parseNumericFlag(process.argv, "--radius-m", ALGO.radius_m),
    from_tolerance_m: parseNumericFlag(process.argv, "--from-tolerance-m", ALGO.from_tolerance_m),
  };

  const host = dbHostOf(process.env.DATABASE_URL);
  if (!host) throw new Error("DATABASE_URL is not set or unparseable.");
  const remoteOk = process.env.ALLOW_REMOTE_DB === "1";
  if (!DRY_RUN && (!isLocalDbHost(host) || isProdDbHost(host)) && !remoteOk) {
    throw new Error(
      `Refusing to write healed coordinates to non-local database host "${host}". ` +
        `Set ALLOW_REMOTE_DB=1 to override.`,
    );
  }
  console.log(`DB host      : ${host}${remoteOk ? "  (ALLOW_REMOTE_DB=1)" : "  (local)"}`);
  console.log(`Mode         : ${DRY_RUN ? "DRY RUN — nothing will be written" : "WRITE"}`);
  console.log(
    `Algorithm    : format v${params.format_version} / algo v${params.algorithm_version}  ` +
      `radius ${params.radius_m}m, ≥${params.min_fixes} fixes / ≥${params.min_distinct_trips} trips, ` +
      `window ${params.window_min}min, from_tolerance ${params.from_tolerance_m}m`,
  );

  const fs = await import("fs");
  let rows: WriteRow[];

  if (FROM) {
    const dump = JSON.parse(fs.readFileSync(FROM, "utf8")) as Dump;
    console.log(`Source       : --from ${FROM} (generated ${dump.generated_at})`);
    const fresh = await computeHeals(params); // recompute the WHOLE pipeline from CURRENT evidence
    const rec = reconcileFromDump(dump, fresh, params); // throws DumpRejected on version/param mismatch
    rows = rec.rows;
    console.log(
      `Reconcile    : ${rows.length} applicable  ` +
        `(${rec.ineligible.length} no-longer-eligible, ${rec.drifted.length} drifted > ${params.from_tolerance_m}m)`,
    );
  } else {
    const candidates = await computeHeals(params);
    console.log(`\nHeals found  : ${candidates.length}`);
    for (const c of candidates) {
      console.log(
        `  ${c.company_name.padEnd(32).slice(0, 32)}  ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}  ` +
          `(${c.n_fixes} fixes / ${c.n_trips} trips)`,
      );
    }
    if (OUT) {
      // Decisions + counts only — buildDump strips everything else, so no raw fix
      // coordinates can leak into the artifact.
      fs.writeFileSync(OUT, JSON.stringify(buildDump(candidates, params), null, 1), "utf8");
      console.log(`\ndump written to ${OUT} (decisions + counts only — no raw fixes)`);
    }
    rows = candidates.map((c) => ({
      consignee_id: c.consignee_id,
      lat: c.lat,
      lng: c.lng,
      current_latitude: c.current_latitude,
      current_longitude: c.current_longitude,
    }));
  }

  if (!DRY_RUN) {
    const r = await applyHeals(prisma as unknown as HealClient, rows);
    console.log(`\n=== WRITE ===`);
    console.log(`  healed (null → driver_fix)      : ${r.written}`);
    console.log(`  skipped, already geocoded       : ${r.skipped_existing}`);
    console.log(`  skipped, partial-coord anomaly  : ${r.skipped_partial}`);
    console.log(`  skipped, lost a write race      : ${r.skipped_race}`);
  }
}

// Only run when executed directly, so the pure exports import cleanly in tests.
if (require.main === module) {
  main()
    .catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
