import { describe, it, expect } from "vitest";
import {
  ALGO,
  metersBetween,
  centroid,
  clusterHeal,
  nearestEligibleFix,
  tripCandidate,
  consigneeCandidates,
  parseNumericFlag,
  type AlgoParams,
  type Fix,
  type RawFix,
  type StopEvidence,
} from "../scripts/self-heal-coords";

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
