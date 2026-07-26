import { describe, it, expect } from "vitest";
import {
  ALGO,
  metersBetween,
  centroid,
  clusterHeal,
  nearestEligibleFix,
  tripCandidate,
  consigneeCandidates,
  clusterOutcome,
  hasDistantCentroidPair,
  selectHealTargets,
  mergeIntervals,
  tripDeliveryIntervals,
  buildLocationLogWhere,
  computeHeals,
  planFromDump,
  buildDump,
  DumpRejected,
  parseNumericFlag,
  parseArgs,
  type AlgoParams,
  type Fix,
  type RawFix,
  type StopEvidence,
  type ConsigneeCoordState,
  type HealDbAdapter,
  type Interval,
} from "../scripts/self-heal-coords";

/** Every ordering of `arr` — used to prove clustering is input-order-independent. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// These pin the geometry + extraction the self-heal turns on. The whole design
// is "only write a coordinate multiple INDEPENDENT trips agree on", so a
// regression here either invents pins (dangerous) or throws real ones away.

// Floating-point boundary work uses an EXPLICIT tolerance, never `===` on a
// derived distance, so the suite does not depend on the host's float rounding.
const EPS_M = 1e-3; // 1 mm — far tighter than any decision we make, safely > float noise

// ~metres-per-degree near UWC's latitude (~5.2°N), used to place fixtures a known
// distance apart without hand-computing haversine.
const M_PER_DEG_LAT = 111_320;
const BASE = { lat: 5.2, lng: 100.44 };
const mPerDegLng = M_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180);
/** A point `north` metres north and `east` metres east of BASE. */
const at = (north: number, east: number) => ({
  lat: BASE.lat + north / M_PER_DEG_LAT,
  lng: BASE.lng + east / mPerDegLng,
});
const fix = (north: number, east: number, trip_id: string): Fix => ({ ...at(north, east), trip_id });

describe("metersBetween", () => {
  it("is zero for identical points and symmetric", () => {
    expect(metersBetween(BASE, BASE)).toBeCloseTo(0, 9);
    expect(metersBetween(at(0, 0), at(50, 0))).toBeCloseTo(metersBetween(at(50, 0), at(0, 0)), 9);
  });

  it("measures a known offset within tolerance", () => {
    expect(Math.abs(metersBetween(at(0, 0), at(100, 0)) - 100)).toBeLessThan(0.5);
  });
});

describe("centroid", () => {
  it("averages positions", () => {
    const c = centroid([at(0, 0), at(90, 0), at(0, 30)]);
    expect(c.lat).toBeCloseTo(at(30, 0).lat, 9);
    expect(c.lng).toBeCloseTo(at(0, 10).lng, 9);
  });
});

describe("clusterHeal — the seed rule", () => {
  it("heals when ≥3 tight candidates come from ≥2 distinct trips", () => {
    const fixes = [fix(0, 0, "t1"), fix(10, 0, "t2"), fix(0, 10, "t3")];
    const r = clusterHeal(fixes);
    expect(r).not.toBeNull();
    expect(r!.n_fixes).toBe(3);
    expect(r!.n_trips).toBe(3);
    const c = centroid(fixes);
    expect(metersBetween(r!, c)).toBeLessThan(EPS_M);
  });

  it("refuses when there are fewer than min_fixes candidates", () => {
    expect(clusterHeal([fix(0, 0, "t1"), fix(5, 0, "t2")])).toBeNull();
  });

  it("refuses 3 tight candidates that all came from ONE trip (need ≥2)", () => {
    // Defensive: extraction already emits one per trip, but the cluster guard
    // still refuses a single-trip cluster so the invariant can never regress.
    expect(clusterHeal([fix(0, 0, "t1"), fix(5, 0, "t1"), fix(0, 5, "t1")])).toBeNull();
  });

  it("refuses when the 3 candidates are spread wider than the radius", () => {
    const fixes = [fix(0, 0, "t1"), fix(0, 300, "t2"), fix(0, 600, "t3")];
    expect(clusterHeal(fixes)).toBeNull();
  });

  it("excludes an outlier and heals from the tight sub-cluster only", () => {
    const tight = [fix(0, 0, "t1"), fix(8, 0, "t2"), fix(0, 8, "t3")];
    const outlier = fix(0, 5_000, "t4");
    const r = clusterHeal([...tight, outlier]);
    expect(r).not.toBeNull();
    expect(r!.n_fixes).toBe(3);
    expect(metersBetween(r!, centroid(tight))).toBeLessThan(EPS_M);
  });

  it("boundary: a candidate exactly at radius_m IS a member (inclusive)", () => {
    const seed = fix(0, 0, "t1");
    const onRing = fix(ALGO.radius_m, 0, "t2");
    expect(Math.abs(metersBetween(seed, onRing) - ALGO.radius_m)).toBeLessThan(0.5);
    const r = clusterHeal([seed, onRing, fix(1, 1, "t3")]);
    expect(r).not.toBeNull();
    expect(r!.n_fixes).toBe(3);
  });

  it("boundary: a candidate just BEYOND radius_m is excluded", () => {
    const seed = fix(0, 0, "t1");
    const justOut = fix(ALGO.radius_m + 5, 0, "t2");
    expect(metersBetween(seed, justOut)).toBeGreaterThan(ALGO.radius_m);
    expect(clusterHeal([seed, justOut, fix(2, 0, "t3")])).toBeNull();
  });

  it("documents the accepted false-negative: a valid ring with no anchoring seed is skipped", () => {
    // Three candidates ~evenly on a ring of radius ~90 m: every pair is > radius_m
    // apart, so NO seed has 3 members within radius, and no heal is written —
    // even though their common centroid (BASE) is a fine estimate.
    const rM = 90;
    const ring: Fix[] = [0, 120, 240].map((deg, i) => {
      const rad = (deg * Math.PI) / 180;
      return fix(rM * Math.cos(rad), rM * Math.sin(rad), `t${i + 1}`);
    });
    expect(metersBetween(ring[0], ring[1])).toBeGreaterThan(ALGO.radius_m);
    expect(clusterHeal(ring)).toBeNull();
  });
});

describe("nearestEligibleFix — nearest fix within window_min", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);
  const raw = (lat: number, lng: number, m: number): RawFix => ({ lat, lng, recorded_at: min(m) });

  it("returns the fix nearest in time to delivered_at, with its gap", () => {
    const p = nearestEligibleFix(D, [raw(1, 1, -4), raw(2, 2, -1), raw(3, 3, 4)], ALGO.window_min);
    expect(p).toEqual({ lat: 2, lng: 2, gap_ms: 60_000 });
  });

  it("returns null when every fix is outside window_min", () => {
    expect(nearestEligibleFix(D, [raw(1, 1, ALGO.window_min + 1)], ALGO.window_min)).toBeNull();
  });

  it("boundary: a fix exactly window_min away is still accepted (inclusive)", () => {
    const p = nearestEligibleFix(D, [raw(9, 9, ALGO.window_min)], ALGO.window_min);
    expect(p).toEqual({ lat: 9, lng: 9, gap_ms: ALGO.window_min * 60_000 });
  });
});

describe("tripCandidate — one fix per trip (smallest delivery-time gap)", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);
  const stop = (m: number): StopEvidence => ({ trip_id: "tA", delivered_at: min(m) });
  const raw = (lat: number, lng: number, m: number): RawFix => ({ lat, lng, recorded_at: min(m) });

  it("keeps the stop/fix pairing with the smallest time difference", () => {
    // Two stops on the same trip; fixes sit right at each stop's time. The stop
    // whose nearest fix is closest in time wins.
    const stops = [stop(0), stop(3)];
    const fixes = [raw(1, 1, 2), raw(2, 2, 3)]; // stop(3) → fix@3 gap 0; stop(0) → fix@2 gap 2
    const c = tripCandidate(stops, fixes, ALGO.window_min);
    expect(c).toEqual({ lat: 2, lng: 2, gap_ms: 0 });
  });
});

describe("consigneeCandidates — at most ONE candidate per (consignee, trip)", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);
  const stop = (trip_id: string, m: number): StopEvidence => ({ trip_id, delivered_at: min(m) });

  it("collapses several stops on the same trip into one candidate", () => {
    const stops = [stop("tA", 0), stop("tA", 1)];
    const logs = new Map<string, RawFix[]>([
      ["tA", [{ lat: 5.2, lng: 100.44, recorded_at: min(0) }]],
    ]);
    const cands = consigneeCandidates(stops, logs, ALGO.window_min);
    expect(cands).toHaveLength(1);
    expect(cands[0].trip_id).toBe("tA");
  });

  it("REGRESSION: 2 stops on Trip A + 1 on Trip B ⇒ 2 candidates ⇒ NOT a heal", () => {
    // Both trips park at the same building, so geometry would love to cluster —
    // but that is only TWO independent trips, below min_fixes. Must NOT heal.
    const here = { lat: BASE.lat, lng: BASE.lng };
    const stops = [stop("tA", 0), stop("tA", 2), stop("tB", 0)];
    const logs = new Map<string, RawFix[]>([
      ["tA", [{ ...here, recorded_at: min(0) }]],
      ["tB", [{ ...here, recorded_at: min(0) }]],
    ]);
    const cands = consigneeCandidates(stops, logs, ALGO.window_min);
    expect(cands).toHaveLength(2); // one per trip, not one per stop
    expect(new Set(cands.map((c) => c.trip_id))).toEqual(new Set(["tA", "tB"]));
    expect(clusterHeal(cands)).toBeNull(); // insufficient — two trips, need three
  });

  it("three DISTINCT trips at the same spot ⇒ 3 candidates ⇒ heals", () => {
    const here = { lat: BASE.lat, lng: BASE.lng };
    const stops = [stop("tA", 0), stop("tB", 0), stop("tC", 0)];
    const logs = new Map<string, RawFix[]>([
      ["tA", [{ ...here, recorded_at: min(0) }]],
      ["tB", [{ lat: here.lat + 5 / M_PER_DEG_LAT, lng: here.lng, recorded_at: min(0) }]],
      ["tC", [{ lat: here.lat, lng: here.lng + 5 / mPerDegLng, recorded_at: min(0) }]],
    ]);
    const cands = consigneeCandidates(stops, logs, ALGO.window_min);
    expect(cands).toHaveLength(3);
    const r = clusterHeal(cands);
    expect(r).not.toBeNull();
    expect(r!.n_trips).toBe(3);
  });
});

describe("clusterOutcome — deterministic + ambiguity", () => {
  it("returns a heal for a single confident cluster", () => {
    const o = clusterOutcome([fix(0, 0, "t1"), fix(8, 0, "t2"), fix(0, 8, "t3")]);
    expect(o.kind).toBe("heal");
  });

  it("returns AMBIGUOUS for two equally-strong, spatially-distinct clusters (never heals)", () => {
    // Cluster A around BASE; cluster B ~500 m east — both exactly 3 trips.
    const a = [fix(0, 0, "t1"), fix(6, 0, "t2"), fix(0, 6, "t3")];
    const b = [fix(0, 500, "t4"), fix(6, 500, "t5"), fix(0, 506, "t6")];
    const o = clusterOutcome([...a, ...b]);
    expect(o.kind).toBe("ambiguous");
    if (o.kind === "ambiguous") expect(o.centroids.length).toBe(2);
    // The convenience wrapper refuses to guess.
    expect(clusterHeal([...a, ...b])).toBeNull();
  });

  it("PERMUTATION: every ordering of a healable set yields an identical centroid", () => {
    const set = [fix(0, 0, "t1"), fix(9, 0, "t2"), fix(0, 9, "t3"), fix(4, 4, "t4")];
    const results = permutations(set).map((p) => clusterHeal(p));
    for (const r of results) expect(r).not.toBeNull();
    const first = results[0]!;
    for (const r of results) {
      expect(metersBetween(r!, first)).toBeLessThan(EPS_M); // same centroid regardless of order
      expect(r!.n_fixes).toBe(first.n_fixes);
      expect(r!.n_trips).toBe(first.n_trips);
    }
  });

  it("BRIDGED-CLUSTER regression: A~B ≤ r, B~C ≤ r, A~C > r ⇒ ambiguous for every permutation", () => {
    // hasDistantCentroidPair compares EVERY pair (no greedy representative
    // grouping), so a chain where the ends are far apart is correctly flagged.
    // A east 0, B east 90, C east 180 (radius 100): A-B=90≤100, B-C=90≤100, A-C=180>100.
    const A = at(0, 0);
    const B = at(0, 90);
    const C = at(0, 180);
    expect(metersBetween(A, B)).toBeLessThanOrEqual(ALGO.radius_m);
    expect(metersBetween(B, C)).toBeLessThanOrEqual(ALGO.radius_m);
    expect(metersBetween(A, C)).toBeGreaterThan(ALGO.radius_m);
    for (const p of permutations([A, B, C])) {
      expect(hasDistantCentroidPair(p, ALGO.radius_m)).toBe(true); // refuse, order-free
    }
    // Control: three mutually-close centroids are NOT distant.
    for (const p of permutations([at(0, 0), at(0, 10), at(0, 20)])) {
      expect(hasDistantCentroidPair(p, ALGO.radius_m)).toBe(false);
    }
  });

  it("PERMUTATION: every ordering of an ambiguous set refuses identically", () => {
    const a = [fix(0, 0, "t1"), fix(6, 0, "t2"), fix(0, 6, "t3")];
    const b = [fix(0, 500, "t4"), fix(6, 500, "t5"), fix(0, 506, "t6")];
    const set = [...a, ...b];
    // 6! = 720 orderings; all must be "ambiguous" and all must refuse to heal.
    for (const p of permutations(set)) {
      expect(clusterOutcome(p).kind).toBe("ambiguous");
      expect(clusterHeal(p)).toBeNull();
    }
  });
});

describe("selectHealTargets — symmetric partial detection", () => {
  const row = (id: string, lat: number | null, lng: number | null): ConsigneeCoordState => ({
    id,
    latitude: lat,
    longitude: lng,
  });

  it("treats ONLY fully-null pairs as eligible for computation", () => {
    const t = selectHealTargets([row("full", null, null), row("done", 5.2, 100.4)]);
    expect(t.eligible).toEqual(["full"]);
    expect(t.partial).toEqual([]);
  });

  it("reports a latitude-null / longitude-set anomaly (not eligible)", () => {
    const t = selectHealTargets([row("a", null, 100.4)]);
    expect(t.eligible).toEqual([]);
    expect(t.partial).toEqual([{ id: "a", orientation: "latitude_null_longitude_set" }]);
  });

  it("reports a latitude-set / longitude-null anomaly (not eligible)", () => {
    const t = selectHealTargets([row("b", 5.2, null)]);
    expect(t.eligible).toEqual([]);
    expect(t.partial).toEqual([{ id: "b", orientation: "latitude_set_longitude_null" }]);
  });

  it("partitions a mixed batch and never puts a partial row into eligible", () => {
    const t = selectHealTargets([
      row("full", null, null),
      row("latnull", null, 100.4),
      row("lngnull", 5.2, null),
      row("done", 5.2, 100.4),
    ]);
    expect(t.eligible).toEqual(["full"]);
    expect(t.partial.map((p) => p.id).sort()).toEqual(["latnull", "lngnull"]);
  });
});

describe("mergeIntervals + tripDeliveryIntervals — exact delivery-window unions", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);
  const iv = (a: number, b: number): Interval => ({ gte: min(a), lte: min(b) });

  it("merges overlapping/touching intervals", () => {
    const m = mergeIntervals([iv(0, 10), iv(5, 15), iv(15, 20)]);
    expect(m).toHaveLength(1);
    expect(m[0].gte.getTime()).toBe(min(0).getTime());
    expect(m[0].lte.getTime()).toBe(min(20).getTime());
  });

  it("PRESERVES a real gap between separated intervals", () => {
    const m = mergeIntervals([iv(0, 10), iv(100, 110)]);
    expect(m).toHaveLength(2);
  });

  it("builds a per-stop ±window interval, merging only overlaps", () => {
    // Two deliveries 3 min apart (windows overlap → merge); a third 8 h later (gap).
    const merged = tripDeliveryIntervals([min(0), min(3), min(480)], 5);
    expect(merged).toHaveLength(2);
    expect(merged[0].gte.getTime()).toBe(min(-5).getTime());
    expect(merged[0].lte.getTime()).toBe(min(8).getTime());
    expect(merged[1].gte.getTime()).toBe(min(475).getTime());
  });

  it("candidate extraction still ignores irrelevant history far from delivery", () => {
    const relevant: RawFix = { lat: BASE.lat, lng: BASE.lng, recorded_at: min(0) };
    const ancientHistory: RawFix[] = Array.from({ length: 500 }, (_, i) => ({
      lat: BASE.lat + 0.05,
      lng: BASE.lng + 0.05,
      recorded_at: min(-600 - i),
    }));
    const logs = new Map<string, RawFix[]>([["tA", [...ancientHistory, relevant]]]);
    const cands = consigneeCandidates([{ trip_id: "tA", delivered_at: min(0) }], logs, ALGO.window_min);
    expect(cands).toHaveLength(1);
    expect(metersBetween(cands[0], relevant)).toBeLessThan(EPS_M);
  });
});

describe("buildLocationLogWhere — phone-only, per-merged-interval predicate", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);

  it("emits one phone-scoped OR branch per interval, stably ordered; null when empty", () => {
    const w = buildLocationLogWhere(
      new Map<string, Interval[]>([["tA", [{ gte: min(0), lte: min(10) }, { gte: min(100), lte: min(110) }]]]),
    )!;
    expect(w.OR).toHaveLength(2);
    for (const branch of w.OR) {
      expect(branch.trip_id).toBe("tA");
      expect(branch.source).toBe("phone");
    }
    expect(buildLocationLogWhere(new Map())).toBeNull();
  });
});

describe("computeHeals — production path via injected DB adapter", () => {
  const D = new Date("2026-07-24T10:00:00Z");
  const min = (m: number) => new Date(D.getTime() + m * 60_000);

  // A recording mock adapter; each findMany returns canned rows and captures args.
  function mockDb(overrides: Partial<Record<keyof HealDbAdapter, unknown>> = {}) {
    const calls: { consignee: unknown[]; tripStop: unknown[]; locationLog: unknown[] } = {
      consignee: [],
      tripStop: [],
      locationLog: [],
    };
    const db: HealDbAdapter = {
      consignee: {
        findMany: async (a) => {
          calls.consignee.push(a);
          return [{ id: "c1", company_name: "ANON", latitude: null, longitude: null }];
        },
      },
      tripStop: {
        findMany: async (a) => {
          calls.tripStop.push(a);
          // ONE trip, two deliveries 8 h apart → two separated windows.
          return [
            { consignee_id: "c1", trip_id: "tA", delivered_at: min(0) },
            { consignee_id: "c1", trip_id: "tA", delivered_at: min(480) },
          ];
        },
      },
      locationLog: {
        findMany: async (a) => {
          calls.locationLog.push(a);
          return [];
        },
      },
      ...(overrides as Partial<HealDbAdapter>),
    };
    return { db, calls };
  }

  it("bounds the LocationLog query to phone fixes inside the two delivery windows, excluding the gap", async () => {
    const { db, calls } = mockDb();
    await computeHeals(ALGO, db);
    expect(calls.locationLog).toHaveLength(1);
    const where = (calls.locationLog[0] as { where: { OR: { trip_id: string; source: string; recorded_at: { gte: Date; lte: Date } }[] } }).where;
    expect(where.OR).toHaveLength(2); // two separated windows, gap preserved
    for (const b of where.OR) expect(b.source).toBe("phone");

    // A timestamp in the GAP between the two deliveries must match NO interval.
    const between = min(240).getTime(); // 4 h after first, 4 h before second
    const inSomeWindow = where.OR.some(
      (b) => between >= b.recorded_at.gte.getTime() && between <= b.recorded_at.lte.getTime(),
    );
    expect(inSomeWindow).toBe(false);

    // The delivery timestamps themselves DO fall inside a window.
    for (const t of [min(0).getTime(), min(480).getTime()]) {
      expect(where.OR.some((b) => t >= b.recorded_at.gte.getTime() && t <= b.recorded_at.lte.getTime())).toBe(true);
    }
  });

  it("reports a partial-coordinate consignee and never queries stops/logs for it", async () => {
    const { db, calls } = mockDb({
      consignee: {
        findMany: async () => [{ id: "p1", company_name: "ANON", latitude: 5.2, longitude: null }],
      },
    } as Partial<HealDbAdapter>);
    const { candidates, partial } = await computeHeals(ALGO, db);
    expect(candidates).toEqual([]);
    expect(partial).toEqual([{ id: "p1", orientation: "latitude_set_longitude_null" }]);
    expect(calls.tripStop).toHaveLength(0); // no eligible rows → no further queries
    expect(calls.locationLog).toHaveLength(0);
  });
});

describe("planFromDump — strict validation BEFORE any database access", () => {
  // An adapter that FAILS the test if any method is called.
  function forbiddenDb(): HealDbAdapter {
    const boom = (): never => {
      throw new Error("database must not be queried for an invalid dump");
    };
    return {
      consignee: { findMany: boom as never },
      tripStop: { findMany: boom as never },
      locationLog: { findMany: boom as never },
    };
  }

  it("rejects invalid JSON without any DB call", async () => {
    await expect(planFromDump("{ not json", ALGO, forbiddenDb())).rejects.toBeInstanceOf(DumpRejected);
  });

  it("rejects a malformed (bad structure) dump without any DB call", async () => {
    const bad = JSON.stringify({ ...buildDump([], ALGO), heals: "nope" });
    await expect(planFromDump(bad, ALGO, forbiddenDb())).rejects.toThrow(/heals must be an array/);
  });

  it("rejects a version mismatch without any DB call", async () => {
    const bad = JSON.stringify({ ...buildDump([], ALGO), algorithm_version: 2 });
    await expect(planFromDump(bad, ALGO, forbiddenDb())).rejects.toThrow(/algorithm_version/);
  });
});

describe("parseArgs — strict, complete CLI parsing", () => {
  it("omitted optional flags keep defaults; booleans off", () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ dryRun: false, verbose: false, out: null, from: null });
    expect(a.params.radius_m).toBe(100);
    expect(a.params.from_tolerance_m).toBe(10);
    expect(a.params.window_min).toBe(5);
  });

  it("parses a full valid command line", () => {
    const a = parseArgs(["--dry-run", "--verbose", "--out", "d.json", "--radius-m", "150", "--from-tolerance-m", "12"]);
    expect(a.dryRun).toBe(true);
    expect(a.verbose).toBe(true);
    expect(a.out).toBe("d.json");
    expect(a.params.radius_m).toBe(150);
    expect(a.params.from_tolerance_m).toBe(12);
  });

  it("rejects unknown flags, including misspellings", () => {
    expect(() => parseArgs(["--dryrun"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--verbos"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--radius"])).toThrow(/unknown flag/); // misspelled --radius-m
    expect(() => parseArgs(["--from-tolerance"])).toThrow(/unknown flag/);
  });

  it("rejects duplicate singleton flags (boolean and value)", () => {
    expect(() => parseArgs(["--dry-run", "--dry-run"])).toThrow(/duplicate flag --dry-run/);
    expect(() => parseArgs(["--out", "a.json", "--out", "b.json"])).toThrow(/duplicate flag --out/);
  });

  it("rejects unexpected positional arguments", () => {
    expect(() => parseArgs(["apply"])).toThrow(/unexpected positional/);
    expect(() => parseArgs(["--dry-run", "extra"])).toThrow(/unexpected positional/);
  });

  it("rejects a missing --out / --from value (last token or a flag mistaken for it)", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out requires a value/);
    expect(() => parseArgs(["--from", "--dry-run"])).toThrow(/--from requires a value/);
    expect(() => parseArgs(["--out", ""])).toThrow(/--out requires a value/);
  });

  it("still enforces positive-finite numeric values through the parser", () => {
    expect(() => parseArgs(["--radius-m", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--radius-m", "-5"])).toThrow(/positive/);
    expect(() => parseArgs(["--from-tolerance-m", "NaN"])).toThrow(/finite number/);
    expect(() => parseArgs(["--window-min", "abc"])).toThrow(/finite number/);
  });
});

describe("parseNumericFlag — the --radius-m / --from-tolerance-m / --window-min overrides", () => {
  it("returns the default when the flag is OMITTED entirely", () => {
    // Omitting --radius-m / --from-tolerance-m must use 100 / 10 (no error).
    expect(parseNumericFlag([], "--radius-m", 100)).toBe(100);
    expect(parseNumericFlag(["--dry-run", "--out", "f.json"], "--from-tolerance-m", 10)).toBe(10);
    expect(parseNumericFlag([], "--window-min", 5)).toBe(5);
  });

  it("parses a valid positive override", () => {
    expect(parseNumericFlag(["--radius-m", "150"], "--radius-m", 100)).toBe(150);
    expect(parseNumericFlag(["--from-tolerance-m", "12.5"], "--from-tolerance-m", 10)).toBe(12.5);
    expect(parseNumericFlag(["--window-min", "8"], "--window-min", 5)).toBe(8);
    // Scientific notation is still a finite positive number.
    expect(parseNumericFlag(["--radius-m", "1e2"], "--radius-m", 100)).toBe(100);
  });

  it("rejects a flag supplied with NO following value (flag is the last token)", () => {
    expect(() => parseNumericFlag(["--radius-m"], "--radius-m", 100)).toThrow(/requires a value/);
  });

  it("rejects an EMPTY value", () => {
    expect(() => parseNumericFlag(["--radius-m", ""], "--radius-m", 100)).toThrow(/requires a value/);
  });

  it("rejects the NEXT CLI flag being mistaken for the value", () => {
    expect(() => parseNumericFlag(["--radius-m", "--dry-run"], "--radius-m", 100)).toThrow(
      /followed by the flag/,
    );
    expect(() => parseNumericFlag(["--from-tolerance-m", "--out"], "--from-tolerance-m", 10)).toThrow(
      /followed by the flag/,
    );
  });

  it("rejects non-numeric input", () => {
    expect(() => parseNumericFlag(["--radius-m", "abc"], "--radius-m", 100)).toThrow(/finite number/);
    expect(() => parseNumericFlag(["--radius-m", "100abc"], "--radius-m", 100)).toThrow(/finite number/);
  });

  it("rejects zero and negative numbers", () => {
    expect(() => parseNumericFlag(["--radius-m", "0"], "--radius-m", 100)).toThrow(/positive/);
    expect(() => parseNumericFlag(["--from-tolerance-m", "-5"], "--from-tolerance-m", 10)).toThrow(/positive/);
  });

  it("rejects NaN and Infinity (both signs)", () => {
    expect(() => parseNumericFlag(["--radius-m", "NaN"], "--radius-m", 100)).toThrow(/finite number/);
    expect(() => parseNumericFlag(["--radius-m", "Infinity"], "--radius-m", 100)).toThrow(/finite number/);
    expect(() => parseNumericFlag(["--from-tolerance-m", "-Infinity"], "--from-tolerance-m", 10)).toThrow(
      /finite number/,
    );
  });
});

describe("ALGO parameters are the approved ones", () => {
  it("matches the approved design numbers", () => {
    const expected: AlgoParams = {
      format_version: 1,
      algorithm_version: 1,
      window_min: 5,
      radius_m: 100,
      min_fixes: 3,
      min_distinct_trips: 2,
      from_tolerance_m: 10,
    };
    expect(ALGO).toEqual(expected);
  });
});
