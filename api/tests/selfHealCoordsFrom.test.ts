import { describe, it, expect, vi } from "vitest";
import {
  ALGO,
  buildDump,
  validateDump,
  reconcileFromDump,
  applyHeals,
  DumpRejected,
  type Dump,
  type HealDecision,
  type Candidate,
  type WriteRow,
  type HealClient,
} from "../scripts/self-heal-coords";

// --from does NOT replay stored GPS — the dump holds only DECISIONS + counts.
// It reconciles a saved decision against evidence recomputed FRESH from the DB.
// These tests cover: the dump carries no raw fixes; the version/parameter gate;
// the eligibility + drift reconciliation; and the fill-nulls-only full-pair
// write guard. No live database — persistence takes an injected client.

const BASE = { lat: 5.2, lng: 100.44 };

function decision(over: Partial<HealDecision> = {}): HealDecision {
  return {
    consignee_id: "c1",
    company_name: "ANON WIDGETS SDN BHD",
    lat: BASE.lat,
    lng: BASE.lng,
    n_fixes: 3,
    n_trips: 3,
    ...over,
  };
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

const validDump = (): Dump => buildDump([decision()], ALGO);

describe("buildDump — decisions + counts only, NO raw fixes", () => {
  it("records top-level metadata and every algorithm parameter", () => {
    const d = validDump();
    expect(d.format_version).toBe(ALGO.format_version);
    expect(d.algorithm_version).toBe(ALGO.algorithm_version);
    expect(Number.isNaN(Date.parse(d.generated_at))).toBe(false);
    expect(d.window_min).toBe(ALGO.window_min);
    expect(d.radius_m).toBe(ALGO.radius_m);
    expect(d.min_fixes).toBe(ALGO.min_fixes);
    expect(d.min_distinct_trips).toBe(ALGO.min_distinct_trips);
    expect(d.from_tolerance_m).toBe(ALGO.from_tolerance_m);
  });

  it("each heal has ONLY decision + count fields — no fixes / coordinates arrays", () => {
    const d = validDump();
    const heal = d.heals[0];
    expect(Object.keys(heal).sort()).toEqual(
      ["company_name", "consignee_id", "lat", "lng", "n_fixes", "n_trips"].sort(),
    );
    // Belt-and-braces: nothing in the serialized dump smells like a raw GPS trace.
    // (Note: "fixes" alone would collide with the min_fixes/n_fixes COUNT keys,
    // so we match the raw-fix array key + per-fix fields instead.)
    const json = JSON.stringify(d);
    expect(json).not.toContain('"fixes"');
    expect(json).not.toContain("trip_id");
    expect(json).not.toContain("recorded_at");
    expect(json).not.toContain("gap_ms");
  });

  it("ignores any extra fields on the input decision (cannot leak fixes)", () => {
    // Even if a caller hands buildDump an object with a stray `fixes` field,
    // buildDump projects to the decision shape and drops it.
    const dirty = { ...decision(), fixes: [{ lat: 1, lng: 2, trip_id: "t" }] } as unknown as HealDecision;
    const d = buildDump([dirty], ALGO);
    expect(JSON.stringify(d)).not.toContain('"fixes"');
    expect(JSON.stringify(d)).not.toContain("trip_id");
    expect((d.heals[0] as Record<string, unknown>).fixes).toBeUndefined();
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
