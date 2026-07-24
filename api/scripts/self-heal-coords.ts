/**
 * Consignee coordinate SELF-HEALING from driver GPS.
 *
 * A consignee whose address the Google geocoder could not place (BOTH latitude
 * AND longitude NULL — a coarse zone-fallback stop) can still be pinned from
 * where trucks actually STOP to deliver to it. When enough INDEPENDENT trips
 * agree on a spot, that spot IS the building.
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
 * ── Deterministic, conservative clustering ──────────────────────────────────
 * Candidates are canonically SORTED, then clustered by a SEED-based method: a
 * heal is written only when some candidate (the "seed") has at least `min_fixes`
 * candidates within `radius_m` of it, drawn from at least `min_distinct_trips`
 * DISTINCT trips. Among the equally-strongest qualifying clusters a canonical
 * tie-break picks the winner, so the result is INDEPENDENT of input order. If
 * two spatially DISTINCT clusters are equally strong the outcome is AMBIGUOUS
 * and NOTHING is healed — we never guess between two candidate buildings.
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
 * ── Dump = CONFIDENTIAL OPERATIONAL DATA (decisions + counts only) ───────────
 * A dump records, per heal, only: consignee_id, the DECISION ("heal"), the
 * healed centroid (lat/lng) and EVIDENCE COUNTS (n_fixes, n_trips) — plus
 * top-level metadata (format/algorithm version, timestamp, algorithm
 * parameters, classification). It contains NO company names, NO other consignee
 * metadata, NO individual LocationLog coordinates and NO raw fixes. It is
 * CONFIDENTIAL operational data (it maps a customer to a physical position) and
 * must be handled accordingly. Consequently `--from` is NOT a self-contained
 * replay. It:
 *   1. loads the saved decision + strictly validates structure/version/params;
 *   2. re-reads CURRENT TripStop + LocationLog evidence from the database;
 *   3. recomputes the ENTIRE candidate pipeline from that current evidence;
 *   4. compares the fresh centroid with the saved one;
 *   5. applies only heals that remain ELIGIBLE and land within `from_tolerance_m`,
 *      writing the saved (reviewed) centroid — not the fresh one.
 *
 * By default the console prints COUNTS only — never customer names or precise
 * coordinates. Pass `--verbose` for per-heal detail.
 *
 * Flags:
 *   --dry-run               compute + summarise, write nothing to the DB
 *   --verbose               print per-heal names + coordinates (off by default)
 *   --out <file>            write the confidential decisions dump
 *   --from <file>           reconcile a prior dump against CURRENT DB evidence
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
export const DUMP_CLASSIFICATION = "confidential-operational-data";

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

/** Canonical total order on points: lat, then lng. Deterministic, order-free. */
export function comparePoint(a: Point, b: Point): number {
  if (a.lat !== b.lat) return a.lat - b.lat;
  if (a.lng !== b.lng) return a.lng - b.lng;
  return 0;
}
/** Canonical total order on candidate fixes: lat, lng, then trip_id. */
export function compareFix(a: Fix, b: Fix): number {
  const g = comparePoint(a, b);
  if (g !== 0) return g;
  return a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : 0;
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
 * Returns the fix plus that gap (ms), or null when no fix is close enough in
 * time. On an EXACT gap tie the canonically-smaller point wins, so the result is
 * independent of the order fixes arrive in (e.g. database row order).
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
    if (gap > windowMs) continue;
    if (
      best === null ||
      gap < best.gap_ms ||
      (gap === best.gap_ms && comparePoint(f, best) < 0)
    ) {
      best = { lat: f.lat, lng: f.lng, gap_ms: gap };
    }
  }
  return best;
}

/**
 * The single candidate for ONE (consignee, trip): across every delivered stop of
 * that trip, take each stop's eligible fix and keep the one with the smallest
 * delivery-time difference (canonical point tie-break). null = the trip
 * contributes no evidence.
 */
export function tripCandidate(
  stops: StopEvidence[],
  tripFixes: RawFix[],
  windowMin: number,
): { lat: number; lng: number; gap_ms: number } | null {
  let best: { lat: number; lng: number; gap_ms: number } | null = null;
  for (const s of stops) {
    const near = nearestEligibleFix(s.delivered_at, tripFixes, windowMin);
    if (
      near &&
      (best === null ||
        near.gap_ms < best.gap_ms ||
        (near.gap_ms === best.gap_ms && comparePoint(near, best) < 0))
    ) {
      best = near;
    }
  }
  return best;
}

/**
 * All per-trip candidates for one consignee: group its delivered stops by trip,
 * then emit AT MOST ONE Fix per trip. This is what guarantees N candidates ⇒ N
 * distinct trips. Output is canonically sorted so it is order-free.
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
  return out.sort(compareFix);
}

export interface HealResult extends Point {
  n_fixes: number;
  n_trips: number;
}

/**
 * The result of the seed-based cluster analysis:
 *   - heal:      a single, confident centroid to write;
 *   - none:      no qualifying cluster (or the accepted false-negative);
 *   - ambiguous: two or more equally-strong, spatially-distinct clusters — we
 *                refuse to guess. Never heal on this outcome.
 */
export type ClusterOutcome =
  | { kind: "heal"; result: HealResult }
  | { kind: "none" }
  | { kind: "ambiguous"; centroids: Point[] };

/** A canonical string key for a cluster's member set — used for order-free tie-breaks. */
function clusterKey(members: Fix[]): string {
  return [...members]
    .sort(compareFix)
    .map((m) => `${m.lat},${m.lng},${m.trip_id}`)
    .join("|");
}

/**
 * Deterministic, conservative seed clustering. Canonically sorts candidates,
 * enumerates every qualifying seed-cluster, and:
 *   - returns AMBIGUOUS when ≥2 of the strongest clusters are spatially distinct
 *     (their centroids are more than `radius_m` apart);
 *   - otherwise returns the centroid of the canonical strongest cluster.
 * The output depends only on the SET of candidates, never their order.
 */
export function clusterOutcome(fixes: Fix[], p: AlgoParams = ALGO): ClusterOutcome {
  if (fixes.length < p.min_fixes) return { kind: "none" };
  const sorted = [...fixes].sort(compareFix);

  const clusters: { members: Fix[]; trips: number; centroid: Point; key: string }[] = [];
  for (const seed of sorted) {
    const members = sorted.filter((f) => metersBetween(seed, f) <= p.radius_m);
    const trips = new Set(members.map((m) => m.trip_id)).size;
    if (members.length >= p.min_fixes && trips >= p.min_distinct_trips) {
      clusters.push({ members, trips, centroid: centroid(members), key: clusterKey(members) });
    }
  }
  if (clusters.length === 0) return { kind: "none" };

  const maxSize = Math.max(...clusters.map((c) => c.members.length));
  const top = clusters.filter((c) => c.members.length === maxSize);

  // Are the strongest clusters all the SAME place? Group their centroids by
  // proximity; more than one spatially-distinct group → ambiguous.
  const distinct: Point[] = [];
  for (const c of top) {
    if (!distinct.some((d) => metersBetween(d, c.centroid) <= p.radius_m)) distinct.push(c.centroid);
  }
  if (distinct.length > 1) {
    return { kind: "ambiguous", centroids: distinct.sort(comparePoint) };
  }

  // One place; pick the canonical member set among the ties so the written
  // centroid is invariant to input order.
  const winner = [...top].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
  return {
    kind: "heal",
    result: { lat: winner.centroid.lat, lng: winner.centroid.lng, n_fixes: winner.members.length, n_trips: winner.trips },
  };
}

/**
 * Convenience wrapper: the centroid to write, or null on `none`/`ambiguous`.
 * Callers that must distinguish ambiguity use clusterOutcome() directly.
 */
export function clusterHeal(fixes: Fix[], p: AlgoParams = ALGO): HealResult | null {
  const o = clusterOutcome(fixes, p);
  return o.kind === "heal" ? o.result : null;
}

// ── Symmetric partial-coordinate detection (pure) ────────────────────────────
export type PartialOrientation = "latitude_null_longitude_set" | "latitude_set_longitude_null";
export interface ConsigneeCoordState {
  id: string;
  latitude: number | null;
  longitude: number | null;
}
export interface HealTargets {
  /** Fully-null (both coordinates null) — the ONLY rows eligible for computation. */
  eligible: string[];
  /** Exactly one coordinate present — an anomaly, reported, never computed/written. */
  partial: { id: string; orientation: PartialOrientation }[];
}

/**
 * Partition consignees (queried as "latitude null OR longitude null") into
 * fully-null heal targets and partial-coordinate anomalies. Both partial
 * orientations are reported; only fully-null pairs may enter computation.
 */
export function selectHealTargets(rows: ConsigneeCoordState[]): HealTargets {
  const eligible: string[] = [];
  const partial: { id: string; orientation: PartialOrientation }[] = [];
  for (const r of rows) {
    const latNull = r.latitude === null;
    const lngNull = r.longitude === null;
    if (latNull && lngNull) eligible.push(r.id);
    else if (latNull && !lngNull) partial.push({ id: r.id, orientation: "latitude_null_longitude_set" });
    else if (!latNull && lngNull) partial.push({ id: r.id, orientation: "latitude_set_longitude_null" });
    // both present → fully geocoded; not a target (should not be returned by the query).
  }
  return { eligible, partial };
}

/**
 * Per-trip recorded_at bound for the LocationLog read: the trip's delivery
 * window [min(delivered_at) - window, max(delivered_at) + window]. Bounding the
 * query keeps us from scanning a truck's entire GPS history. null = no stops.
 */
export function deliveryWindowRange(deliveredAts: Date[], windowMin: number): { gte: Date; lte: Date } | null {
  if (deliveredAts.length === 0) return null;
  const times = deliveredAts.map((d) => d.getTime());
  const w = windowMin * 60_000;
  return { gte: new Date(Math.min(...times) - w), lte: new Date(Math.max(...times) + w) };
}

// ── Dump shape (CONFIDENTIAL — decisions + counts only, no raw GPS/PII) ───────
export interface HealDecision {
  consignee_id: string;
  decision: "heal";
  lat: number;
  lng: number;
  n_fixes: number; // evidence count only
  n_trips: number; // evidence count only
}

/** The minimal input buildDump needs; anything extra (names, fixes) is dropped. */
export interface HealInput {
  consignee_id: string;
  lat: number;
  lng: number;
  n_fixes: number;
  n_trips: number;
}

export interface Dump extends AlgoParams {
  generated_at: string;
  classification: string;
  heals: HealDecision[];
}

/** A dump the running algorithm refuses to reconcile. */
export class DumpRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpRejected";
  }
}

export function buildDump(decisions: HealInput[], params: AlgoParams = ALGO): Dump {
  return {
    format_version: params.format_version,
    algorithm_version: params.algorithm_version,
    generated_at: new Date().toISOString(),
    classification: DUMP_CLASSIFICATION,
    window_min: params.window_min,
    radius_m: params.radius_m,
    min_fixes: params.min_fixes,
    min_distinct_trips: params.min_distinct_trips,
    from_tolerance_m: params.from_tolerance_m,
    // Project to the decision shape ONLY — no company name, no other consignee
    // metadata, no fix coordinates can survive this mapping.
    heals: decisions.map((d) => ({
      consignee_id: d.consignee_id,
      decision: "heal" as const,
      lat: d.lat,
      lng: d.lng,
      n_fixes: d.n_fixes,
      n_trips: d.n_trips,
    })),
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPositiveInt = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * STRICT validation, run before any reconciliation or write. Rejects a malformed
 * dump (bad types, missing fields, duplicate/empty ids, out-of-range coordinates,
 * non-positive-integer counts, bad timestamp), an unsupported format/algorithm
 * version, or a dump whose algorithm parameters differ from the ones we would
 * recompute with. Throws DumpRejected; narrows `dump` to Dump on success.
 */
export function validateDump(dump: unknown, params: AlgoParams = ALGO): asserts dump is Dump {
  if (typeof dump !== "object" || dump === null || Array.isArray(dump)) {
    throw new DumpRejected("dump must be a JSON object");
  }
  const d = dump as Record<string, unknown>;

  // Metadata types.
  const numMeta: (keyof AlgoParams)[] = [
    "format_version",
    "algorithm_version",
    "window_min",
    "radius_m",
    "min_fixes",
    "min_distinct_trips",
    "from_tolerance_m",
  ];
  for (const k of numMeta) {
    if (!isFiniteNumber(d[k])) {
      throw new DumpRejected(`metadata ${k} must be a finite number (got ${JSON.stringify(d[k])})`);
    }
  }
  if (typeof d.generated_at !== "string" || Number.isNaN(Date.parse(d.generated_at))) {
    throw new DumpRejected(`generated_at must be a valid timestamp (got ${JSON.stringify(d.generated_at)})`);
  }
  if (typeof d.classification !== "string" || d.classification.length === 0) {
    throw new DumpRejected("classification must be a non-empty string");
  }
  if (!Array.isArray(d.heals)) {
    throw new DumpRejected("heals must be an array");
  }

  // Version support.
  if (d.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new DumpRejected(`unsupported format_version ${d.format_version} (supported: ${SUPPORTED_FORMAT_VERSION})`);
  }
  if (d.algorithm_version !== SUPPORTED_ALGORITHM_VERSION) {
    throw new DumpRejected(`unsupported algorithm_version ${d.algorithm_version} (supported: ${SUPPORTED_ALGORITHM_VERSION})`);
  }

  // Parameter match (effective CLI params must equal the dump's).
  const paramKeys: (keyof AlgoParams)[] = ["window_min", "radius_m", "min_fixes", "min_distinct_trips", "from_tolerance_m"];
  for (const k of paramKeys) {
    if (d[k] !== params[k]) {
      throw new DumpRejected(`parameter mismatch: dump.${k}=${d[k]} but recomputation uses ${params[k]}`);
    }
  }

  // Per-heal structure.
  const seen = new Set<string>();
  for (const h of d.heals as unknown[]) {
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      throw new DumpRejected("each heal must be a JSON object");
    }
    const heal = h as Record<string, unknown>;
    if (typeof heal.consignee_id !== "string" || heal.consignee_id.length === 0) {
      throw new DumpRejected("heal.consignee_id must be a non-empty string");
    }
    if (seen.has(heal.consignee_id)) {
      throw new DumpRejected(`duplicate consignee_id "${heal.consignee_id}"`);
    }
    seen.add(heal.consignee_id);
    if (heal.decision !== "heal") {
      throw new DumpRejected(`heal.decision must be "heal" for "${heal.consignee_id}"`);
    }
    if (!isFiniteNumber(heal.lat) || heal.lat < -90 || heal.lat > 90) {
      throw new DumpRejected(`heal.lat must be finite within [-90,90] for "${heal.consignee_id}" (got ${JSON.stringify(heal.lat)})`);
    }
    if (!isFiniteNumber(heal.lng) || heal.lng < -180 || heal.lng > 180) {
      throw new DumpRejected(`heal.lng must be finite within [-180,180] for "${heal.consignee_id}" (got ${JSON.stringify(heal.lng)})`);
    }
    if (!isPositiveInt(heal.n_fixes)) {
      throw new DumpRejected(`heal.n_fixes must be a positive integer for "${heal.consignee_id}" (got ${JSON.stringify(heal.n_fixes)})`);
    }
    if (!isPositiveInt(heal.n_trips)) {
      throw new DumpRejected(`heal.n_trips must be a positive integer for "${heal.consignee_id}" (got ${JSON.stringify(heal.n_trips)})`);
    }
  }
}

// ── Recomputed evidence (fresh from the DB) ──────────────────────────────────
// A candidate carries the fresh decision PLUS the consignee's CURRENT stored
// coordinates, so the write layer can enforce fill-nulls-only atomically.
// company_name is kept for --verbose console output ONLY and never dumped.
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
 * --from reconciliation (pure): strictly validate the dump, then for each saved
 * decision find the freshly-recomputed candidate for the same consignee and
 * apply it only if it is still eligible (present in `fresh`) and its centroid is
 * within `from_tolerance_m` of the saved one. Returns the write rows plus the
 * consignees skipped as no-longer-eligible or drifted.
 */
export function reconcileFromDump(
  dump: unknown,
  fresh: Candidate[],
  params: AlgoParams = ALGO,
): { rows: WriteRow[]; ineligible: string[]; drifted: string[] } {
  validateDump(dump, params); // throws DumpRejected on any structural/version/param problem
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
    // Owner decision: apply the SAVED (reviewed) centroid; the fresh recompute
    // only GATES it (proves it still reproduces within tolerance).
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
 * Write heals, fill-nulls-only, with PER-ROW ATOMIC COMMITS.
 *
 * A consignee is written ONLY when BOTH stored coordinates are null. A record
 * with exactly ONE coordinate present is a partial-coordinate anomaly and is
 * NEVER modified — the write operation is not even called for it. Each row is its
 * own `updateMany` carrying the same full-pair guard (`latitude: null,
 * longitude: null`) so a coordinate set after this read can never be clobbered.
 *
 * WRITE SEMANTICS — deliberately NOT wrapped in a single transaction (this change
 * adds no all-or-nothing behaviour): each row commits independently, so if a
 * LATER row throws, EARLIER successful rows are NOT rolled back. That is safe and
 * intended, because the operation is idempotent under re-run: the full-pair null
 * guard means a re-run SKIPS every already-filled coordinate (counted as
 * skipped_existing / skipped_race) and only fills consignees still fully null.
 * Re-running after a partial failure simply resumes the remaining work.
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
async function computeHeals(params: AlgoParams): Promise<{ candidates: Candidate[]; partial: HealTargets["partial"] }> {
  // Query consignees missing EITHER coordinate (symmetric), then partition.
  const consignees = await prisma.consignee.findMany({
    where: { OR: [{ latitude: null }, { longitude: null }] },
    select: { id: true, company_name: true, latitude: true, longitude: true },
  });
  const { eligible, partial } = selectHealTargets(consignees);
  const byId = new Map(consignees.map((c) => [c.id, c]));
  if (eligible.length === 0) return { candidates: [], partial };

  const stops = await prisma.tripStop.findMany({
    where: { consignee_id: { in: eligible }, status: "delivered", delivered_at: { not: null } },
    select: { consignee_id: true, trip_id: true, delivered_at: true },
  });
  if (stops.length === 0) return { candidates: [], partial };

  // Per-trip delivery-time ranges bound the LocationLog read to relevant history.
  const deliveredByTrip = new Map<string, Date[]>();
  for (const s of stops) {
    if (!s.delivered_at) continue;
    const arr = deliveredByTrip.get(s.trip_id) ?? [];
    arr.push(s.delivered_at);
    deliveredByTrip.set(s.trip_id, arr);
  }
  const orRanges: { trip_id: string; recorded_at: { gte: Date; lte: Date } }[] = [];
  for (const [trip_id, times] of deliveredByTrip) {
    const range = deliveryWindowRange(times, params.window_min);
    if (range) orRanges.push({ trip_id, recorded_at: range });
  }
  const logs =
    orRanges.length === 0
      ? []
      : await prisma.locationLog.findMany({
          where: { OR: orRanges },
          select: { trip_id: true, latitude: true, longitude: true, recorded_at: true },
          orderBy: [{ recorded_at: "asc" }],
        });
  const logsByTrip = new Map<string, RawFix[]>();
  for (const l of logs) {
    const arr = logsByTrip.get(l.trip_id) ?? [];
    arr.push({ lat: Number(l.latitude), lng: Number(l.longitude), recorded_at: l.recorded_at });
    logsByTrip.set(l.trip_id, arr);
  }
  // Deterministic ordering IN CODE, independent of the database's row order.
  for (const arr of logsByTrip.values()) {
    arr.sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || comparePoint(a, b));
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
    const result = clusterHeal(candidates, params); // null on none/ambiguous → skipped
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
  // Stable dump/report order.
  out.sort((a, b) => (a.consignee_id < b.consignee_id ? -1 : a.consignee_id > b.consignee_id ? 1 : 0));
  return { candidates: out, partial };
}

// ── Strict, complete CLI parsing ─────────────────────────────────────────────
const BOOL_FLAGS = new Set(["--dry-run", "--verbose"]);
const VALUE_FLAGS = new Set(["--out", "--from", "--window-min", "--radius-m", "--from-tolerance-m"]);

export interface ParsedArgs {
  dryRun: boolean;
  verbose: boolean;
  out: string | null;
  from: string | null;
  params: AlgoParams;
}

function positiveFiniteFromString(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a finite number (got "${raw}")`);
  if (n <= 0) throw new Error(`${flag} must be a positive number greater than 0 (got ${n})`);
  return n;
}

/**
 * Standalone numeric-flag parser (kept for focused tests + reuse). OMITTED →
 * default; an explicitly-supplied invalid value is rejected: missing/empty value,
 * the next long flag mistaken for the value, non-numeric, zero/negative,
 * NaN/Infinity.
 */
export function parseNumericFlag(argv: string[], flag: string, defaultValue: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return defaultValue;
  const raw = argv[i + 1];
  if (raw === undefined || raw === "") throw new Error(`${flag} requires a value (a positive finite number)`);
  if (raw.startsWith("--")) throw new Error(`${flag} requires a value but was followed by the flag "${raw}"`);
  return positiveFiniteFromString(flag, raw);
}

/**
 * Strict, COMPLETE argv parser. Rejects unknown flags, duplicate singleton flags,
 * unexpected positional arguments, and value flags with no value (last token or a
 * long flag mistaken for the value). Omitted optional flags keep their defaults.
 * `argv` is the user tokens only (already sliced past node + script path).
 */
export function parseArgs(argv: string[], base: AlgoParams = ALGO): ParsedArgs {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("-")) throw new Error(`unexpected positional argument "${tok}"`);

    if (BOOL_FLAGS.has(tok)) {
      if (seen.has(tok)) throw new Error(`duplicate flag ${tok}`);
      seen.add(tok);
      if (tok === "--dry-run") dryRun = true;
      else verbose = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      if (seen.has(tok)) throw new Error(`duplicate flag ${tok}`);
      seen.add(tok);
      const val = argv[i + 1];
      if (val === undefined || val === "" || val.startsWith("--")) {
        throw new Error(`${tok} requires a value`);
      }
      values[tok] = val;
      i++; // consume the value token
      continue;
    }
    throw new Error(`unknown flag ${tok}`);
  }

  const num = (flag: string, def: number) => (flag in values ? positiveFiniteFromString(flag, values[flag]) : def);
  const params: AlgoParams = {
    ...base,
    window_min: num("--window-min", base.window_min),
    radius_m: num("--radius-m", base.radius_m),
    from_tolerance_m: num("--from-tolerance-m", base.from_tolerance_m),
  };
  return {
    dryRun,
    verbose,
    out: values["--out"] ?? null,
    from: values["--from"] ?? null,
    params,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dryRun, verbose, out: OUT, from: FROM, params } = args;

  const host = dbHostOf(process.env.DATABASE_URL);
  if (!host) throw new Error("DATABASE_URL is not set or unparseable.");
  const remoteOk = process.env.ALLOW_REMOTE_DB === "1";
  if (!dryRun && (!isLocalDbHost(host) || isProdDbHost(host)) && !remoteOk) {
    throw new Error(
      `Refusing to write healed coordinates to non-local database host "${host}". ` +
        `Set ALLOW_REMOTE_DB=1 to override.`,
    );
  }
  console.log(`DB host      : ${host}${remoteOk ? "  (ALLOW_REMOTE_DB=1)" : "  (local)"}`);
  console.log(`Mode         : ${dryRun ? "DRY RUN — nothing will be written" : "WRITE"}${verbose ? "  (verbose)" : ""}`);
  console.log(
    `Algorithm    : format v${params.format_version} / algo v${params.algorithm_version}  ` +
      `radius ${params.radius_m}m, ≥${params.min_fixes} fixes / ≥${params.min_distinct_trips} trips, ` +
      `window ${params.window_min}min, from_tolerance ${params.from_tolerance_m}m`,
  );

  const fs = await import("fs");
  const { candidates, partial } = await computeHeals(params);

  const latNull = partial.filter((p) => p.orientation === "latitude_null_longitude_set").length;
  const lngNull = partial.filter((p) => p.orientation === "latitude_set_longitude_null").length;
  console.log(
    `Partial-coord anomalies (excluded): ${partial.length}  ` +
      `[lat null / lng set: ${latNull}] [lat set / lng null: ${lngNull}]`,
  );

  let rows: WriteRow[];

  if (FROM) {
    const dump = JSON.parse(fs.readFileSync(FROM, "utf8")) as unknown;
    const rec = reconcileFromDump(dump, candidates, params); // strict-validates, throws on any problem
    rows = rec.rows;
    console.log(
      `Reconcile    : ${rows.length} applicable  ` +
        `(${rec.ineligible.length} no-longer-eligible, ${rec.drifted.length} drifted > ${params.from_tolerance_m}m)`,
    );
  } else {
    console.log(`Heals found  : ${candidates.length}`);
    if (verbose) {
      for (const c of candidates) {
        console.log(
          `  ${c.company_name.padEnd(32).slice(0, 32)}  ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}  ` +
            `(${c.n_fixes} fixes / ${c.n_trips} trips)`,
        );
      }
    }
    if (OUT) {
      fs.writeFileSync(OUT, JSON.stringify(buildDump(candidates, params), null, 1), "utf8");
      console.log(`dump written to ${OUT} (${DUMP_CLASSIFICATION} — decisions + counts only, no names/fixes)`);
    }
    rows = candidates.map((c) => ({
      consignee_id: c.consignee_id,
      lat: c.lat,
      lng: c.lng,
      current_latitude: c.current_latitude,
      current_longitude: c.current_longitude,
    }));
  }

  if (!dryRun) {
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
