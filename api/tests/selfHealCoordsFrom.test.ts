import { describe, it, expect, vi } from "vitest";
import {
  ALGO,
  DUMP_CLASSIFICATION,
  buildDump,
  validateDump,
  reconcileFromDump,
  applyHeals,
  DumpRejected,
  type Dump,
  type HealInput,
  type Candidate,
  type WriteRow,
  type HealClient,
} from "../scripts/self-heal-coords";

// --from does NOT replay stored GPS — the dump holds only DECISIONS + counts and
// is CONFIDENTIAL operational data (no names, no PII, no raw fixes). It reconciles
// a saved decision against evidence recomputed FRESH from the DB. These tests
// cover: dump confidentiality; strict structural + version/parameter validation;
// eligibility + drift reconciliation; and the fill-nulls-only full-pair write
// guard. No live database — persistence takes an injected client.

const BASE = { lat: 5.2, lng: 100.44 };

function healInput(over: Partial<HealInput> = {}): HealInput {
  return { consignee_id: "c1", lat: BASE.lat, lng: BASE.lng, n_fixes: 3, n_trips: 3, ...over };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    consignee_id: "c1",
    company_name: "ANON WIDGETS SDN BHD",
    lat: BASE.lat,
    lng: BASE.lng,
    n_fixes: 3,
    n_trips: 3,
    current_latitude: null,
    current_longitude: null,
    ...over,
  };
}

const validDump = (): Dump => buildDump([healInput()], ALGO);

// A structurally-valid raw heal object + a dump with arbitrary heals, for the
// strict-validation cases (validateDump accepts `unknown`, so we pass raw objects).
const rawHeal = (over: Record<string, unknown> = {}) => ({
  consignee_id: "c1",
  decision: "heal",
  lat: BASE.lat,
  lng: BASE.lng,
  n_fixes: 3,
  n_trips: 3,
  ...over,
});
const withHeals = (heals: unknown[]): unknown => ({ ...validDump(), heals });

describe("buildDump — CONFIDENTIAL decisions + counts only", () => {
  it("records all top-level metadata, every parameter, and the confidentiality classification", () => {
    const d = validDump();
    expect(d.format_version).toBe(ALGO.format_version);
    expect(d.algorithm_version).toBe(ALGO.algorithm_version);
    expect(Number.isNaN(Date.parse(d.generated_at))).toBe(false);
    expect(d.classification).toBe(DUMP_CLASSIFICATION);
    expect(d.window_min).toBe(ALGO.window_min);
    expect(d.radius_m).toBe(ALGO.radius_m);
    expect(d.min_fixes).toBe(ALGO.min_fixes);
    expect(d.min_distinct_trips).toBe(ALGO.min_distinct_trips);
    expect(d.from_tolerance_m).toBe(ALGO.from_tolerance_m);
  });

  it("each heal has ONLY consignee_id + decision + centroid + counts — nothing else", () => {
    const d = validDump();
    expect(Object.keys(d.heals[0]).sort()).toEqual(
      ["consignee_id", "decision", "lat", "lng", "n_fixes", "n_trips"].sort(),
    );
    expect(d.heals[0].decision).toBe("heal");
  });

  it("PRIVACY: no company name, no unrelated consignee metadata, no raw fixes survive", () => {
    // Feed buildDump an object polluted with names/PII/fixes; the projection drops all.
    const dirty = {
      ...healInput(),
      company_name: "SECRET CUSTOMER SDN BHD",
      address_1: "12 Jalan Rahsia",
      phone: "0123456789",
      fixes: [{ lat: 1, lng: 2, trip_id: "t", recorded_at: "2026-07-24" }],
    } as unknown as HealInput;
    const json = JSON.stringify(buildDump([dirty], ALGO));
    expect(json).not.toContain("SECRET CUSTOMER");
    expect(json).not.toContain("company_name");
    expect(json).not.toContain("address");
    expect(json).not.toContain("phone");
    expect(json).not.toContain("Jalan Rahsia");
    expect(json).not.toContain('"fixes"');
    expect(json).not.toContain("trip_id");
    expect(json).not.toContain("recorded_at");
  });
});

describe("validateDump — version + parameter gate", () => {
  it("accepts a dump made by the current algorithm", () => {
    expect(() => validateDump(validDump())).not.toThrow();
  });

  it("rejects an unsupported format_version", () => {
    expect(() => validateDump({ ...validDump(), format_version: 2 })).toThrow(DumpRejected);
    expect(() => validateDump({ ...validDump(), format_version: 2 })).toThrow(/format_version/);
  });

  it("rejects an unsupported algorithm_version", () => {
    expect(() => validateDump({ ...validDump(), algorithm_version: 99 })).toThrow(/algorithm_version/);
  });

  it.each([
    ["radius_m", 150],
    ["min_fixes", 2],
    ["min_distinct_trips", 3],
    ["window_min", 20],
    ["from_tolerance_m", 5],
  ] as const)("rejects a %s parameter mismatch", (key, value) => {
    const d = { ...validDump(), [key]: value } as Dump;
    expect(() => validateDump(d)).toThrow(DumpRejected);
    expect(() => validateDump(d)).toThrow(new RegExp(key));
  });
});

describe("validateDump — strict structural validation (rejects malformed dumps before any write)", () => {
  it("rejects a non-object / array dump", () => {
    expect(() => validateDump(null)).toThrow(/JSON object/);
    expect(() => validateDump("nope")).toThrow(/JSON object/);
    expect(() => validateDump([validDump()])).toThrow(/JSON object/);
  });

  it("rejects when heals is not an array", () => {
    expect(() => validateDump({ ...validDump(), heals: "nope" })).toThrow(/heals must be an array/);
  });

  it("rejects a missing metadata field", () => {
    const d: Record<string, unknown> = { ...validDump() };
    delete d.radius_m;
    expect(() => validateDump(d)).toThrow(/radius_m must be a finite number/);
  });

  it("rejects non-finite metadata (NaN / Infinity / string)", () => {
    expect(() => validateDump({ ...validDump(), from_tolerance_m: NaN })).toThrow(/finite number/);
    expect(() => validateDump({ ...validDump(), radius_m: Infinity })).toThrow(/finite number/);
    expect(() => validateDump({ ...validDump(), window_min: "5" })).toThrow(/finite number/);
  });

  it("rejects an invalid generated_at timestamp", () => {
    expect(() => validateDump({ ...validDump(), generated_at: "not-a-date" })).toThrow(/generated_at/);
    expect(() => validateDump({ ...validDump(), generated_at: 123 })).toThrow(/generated_at/);
  });

  it("rejects a missing/blank classification", () => {
    const d: Record<string, unknown> = { ...validDump() };
    delete d.classification;
    expect(() => validateDump(d)).toThrow(/classification/);
    expect(() => validateDump({ ...validDump(), classification: "" })).toThrow(/classification/);
  });

  it("rejects a heal that is null / not an object", () => {
    expect(() => validateDump(withHeals([null]))).toThrow(/each heal must be/);
    expect(() => validateDump(withHeals(["x"]))).toThrow(/each heal must be/);
  });

  it("rejects an empty or non-string consignee_id", () => {
    expect(() => validateDump(withHeals([rawHeal({ consignee_id: "" })]))).toThrow(/consignee_id/);
    expect(() => validateDump(withHeals([rawHeal({ consignee_id: 5 })]))).toThrow(/consignee_id/);
  });

  it("rejects duplicate consignee_ids", () => {
    expect(() => validateDump(withHeals([rawHeal(), rawHeal()]))).toThrow(/duplicate consignee_id/);
  });

  it("rejects a bad decision discriminator", () => {
    expect(() => validateDump(withHeals([rawHeal({ decision: "skip" })]))).toThrow(/decision/);
  });

  it("rejects out-of-range or non-finite coordinates", () => {
    expect(() => validateDump(withHeals([rawHeal({ lat: 91 })]))).toThrow(/lat/);
    expect(() => validateDump(withHeals([rawHeal({ lat: -90.001 })]))).toThrow(/lat/);
    expect(() => validateDump(withHeals([rawHeal({ lng: 181 })]))).toThrow(/lng/);
    expect(() => validateDump(withHeals([rawHeal({ lng: -181 })]))).toThrow(/lng/);
    expect(() => validateDump(withHeals([rawHeal({ lat: NaN })]))).toThrow(/lat/);
    expect(() => validateDump(withHeals([rawHeal({ lng: "x" })]))).toThrow(/lng/);
  });

  it("rejects non-positive-integer counts", () => {
    expect(() => validateDump(withHeals([rawHeal({ n_fixes: 0 })]))).toThrow(/n_fixes/);
    expect(() => validateDump(withHeals([rawHeal({ n_fixes: -1 })]))).toThrow(/n_fixes/);
    expect(() => validateDump(withHeals([rawHeal({ n_trips: 2.5 })]))).toThrow(/n_trips/);
    expect(() => validateDump(withHeals([rawHeal({ n_trips: "3" })]))).toThrow(/n_trips/);
  });
});

describe("reconcileFromDump — eligibility + drift against FRESH evidence", () => {
  it("applies a saved decision that still clusters within tolerance", () => {
    const rec = reconcileFromDump(validDump(), [candidate()]);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0].consignee_id).toBe("c1");
    expect(rec.rows[0].lat).toBe(BASE.lat); // the saved (approved) centroid is applied
    expect(rec.ineligible).toEqual([]);
    expect(rec.drifted).toEqual([]);
  });

  it("skips a decision that no longer clusters under current evidence", () => {
    const rec = reconcileFromDump(validDump(), []); // fresh recompute found nothing
    expect(rec.rows).toEqual([]);
    expect(rec.ineligible).toEqual(["c1"]);
  });

  it("skips a decision whose fresh centroid drifted beyond from_tolerance_m", () => {
    // Fresh centroid ~111 m north of the saved one — well past the 10 m tolerance.
    const fresh = candidate({ lat: BASE.lat + 0.001, lng: BASE.lng });
    const rec = reconcileFromDump(validDump(), [fresh]);
    expect(rec.rows).toEqual([]);
    expect(rec.drifted).toEqual(["c1"]);
  });

  it("applies a fresh centroid that moved but stayed WITHIN from_tolerance_m", () => {
    // ~5.6 m north — under the 10 m tolerance, so it still applies.
    const fresh = candidate({ lat: BASE.lat + 0.00005, lng: BASE.lng });
    const rec = reconcileFromDump(validDump(), [fresh]);
    expect(rec.rows).toHaveLength(1);
    expect(rec.drifted).toEqual([]);
  });

  it("carries the fresh CURRENT coordinates onto the write row (for the guard)", () => {
    const fresh = candidate({ current_latitude: 5.2, current_longitude: null }); // partial anomaly
    const rec = reconcileFromDump(validDump(), [fresh]);
    expect(rec.rows[0].current_latitude).toBe(5.2);
    expect(rec.rows[0].current_longitude).toBeNull();
  });

  it("rejects the whole dump on a version mismatch before reconciling", () => {
    expect(() => reconcileFromDump({ ...validDump(), algorithm_version: 2 }, [candidate()])).toThrow(DumpRejected);
  });

  it("effective CLI params participate in mismatch validation (a --radius-m override vs a 100 m dump)", () => {
    // A dump made at radius_m=100 reconciled under an effective radius_m=150
    // (i.e. `--from ... --radius-m 150`) must be rejected as a parameter mismatch.
    const overridden = { ...ALGO, radius_m: 150 };
    expect(() => reconcileFromDump(validDump(), [candidate()], overridden)).toThrow(/radius_m/);
    const overriddenTol = { ...ALGO, from_tolerance_m: 25 };
    expect(() => reconcileFromDump(validDump(), [candidate()], overriddenTol)).toThrow(/from_tolerance_m/);
  });
});

describe("applyHeals — fill-nulls-only, full-pair guard (mocked client)", () => {
  function mockClient(counts: number[]): { client: HealClient; updateMany: ReturnType<typeof vi.fn> } {
    let i = 0;
    const updateMany = vi.fn(async () => ({ count: counts[i++] ?? 0 }));
    return { client: { consignee: { updateMany } }, updateMany };
  }
  const row = (over: Partial<WriteRow> = {}): WriteRow => ({
    consignee_id: "c1",
    lat: 5.2,
    lng: 100.44,
    current_latitude: null,
    current_longitude: null,
    ...over,
  });

  it("writes with a FULL-PAIR null guard and geocode_match_type='driver_fix'", async () => {
    const { client, updateMany } = mockClient([1]);
    const res = await applyHeals(client, [row()]);
    expect(res.written).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "c1", latitude: null, longitude: null },
      data: { latitude: 5.2, longitude: 100.44, geocode_match_type: "driver_fix" },
    });
  });

  it("PARTIAL anomaly (latitude set, longitude null): NEVER calls the write operation", async () => {
    const { client, updateMany } = mockClient([1]);
    const res = await applyHeals(client, [row({ current_latitude: 5.2, current_longitude: null })]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(res.skipped_partial).toBe(1);
    expect(res.written).toBe(0);
  });

  it("PARTIAL anomaly (latitude null, longitude set): NEVER calls the write operation", async () => {
    const { client, updateMany } = mockClient([1]);
    const res = await applyHeals(client, [row({ current_latitude: null, current_longitude: 100.44 })]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(res.skipped_partial).toBe(1);
    expect(res.written).toBe(0);
  });

  it("already fully geocoded: skipped without a write", async () => {
    const { client, updateMany } = mockClient([1]);
    const res = await applyHeals(client, [row({ current_latitude: 5.2, current_longitude: 100.44 })]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(res.skipped_existing).toBe(1);
  });

  it("both null but the guarded update matched 0 rows: counted as a lost race", async () => {
    const { client } = mockClient([0]);
    const res = await applyHeals(client, [row()]);
    expect(res).toMatchObject({ written: 0, skipped_race: 1 });
  });

  it("tallies a mix of write / partial / existing rows", async () => {
    const { client, updateMany } = mockClient([1, 1]);
    const res = await applyHeals(client, [
      row({ consignee_id: "a" }),
      row({ consignee_id: "b", current_latitude: 1, current_longitude: null }), // partial
      row({ consignee_id: "c", current_latitude: 1, current_longitude: 1 }), // existing
      row({ consignee_id: "d" }),
    ]);
    expect(res).toMatchObject({ written: 2, skipped_partial: 1, skipped_existing: 1 });
    expect(updateMany).toHaveBeenCalledTimes(2); // only the two fully-null rows
  });

  it("end-to-end: a valid dump reconciles then writes with the full-pair guard", async () => {
    const { client, updateMany } = mockClient([1]);
    const { rows } = reconcileFromDump(validDump(), [candidate()]);
    const res = await applyHeals(client, rows);
    expect(res.written).toBe(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "c1", latitude: null, longitude: null });
    expect(updateMany.mock.calls[0][0].data.geocode_match_type).toBe("driver_fix");
  });
});
