import { describe, it, expect } from "vitest";
import {
  truckRateSnapshot,
  finalizationRateParams,
  dropZonePoints,
  buildPointsByZone,
} from "../src/services/rateSnapshot";
import { calculateDeliveryIncentive } from "../src/services/incentiveEngine";

/**
 * Rate lock (audit fix #1): a trip finalizes at the rates it was ASSIGNED
 * under. An admin editing a truck's claim rate (or a zone's points) between
 * dispatch and completion must not change that trip's pay.
 */

// The engine's holiday calendar is caller-supplied; these tests don't exercise it.
const NO_HOLIDAYS: ReadonlySet<string> = new Set();

// PLX 2406 at assignment time (the RM44 anchor truck).
const TRUCK_AT_ASSIGNMENT = {
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
};

// The same truck after a mid-flight admin rate edit.
const TRUCK_AFTER_EDIT = {
  entitled_claim_weekday: 12,
  entitled_claim_offpeak: 14,
  daily_deduction_points: 3,
};

describe("truckRateSnapshot", () => {
  it("captures exactly the three claim-rate fields written at assignment", () => {
    expect(truckRateSnapshot(TRUCK_AT_ASSIGNMENT)).toEqual({
      entitled_claim_weekday: 11,
      entitled_claim_offpeak: 13,
      daily_deduction_points: 2,
    });
  });

  it("passes Prisma Decimal-like values through untouched", () => {
    const dec = { toString: () => "11.00" };
    const snap = truckRateSnapshot({
      entitled_claim_weekday: dec,
      entitled_claim_offpeak: dec,
      daily_deduction_points: 2,
    });
    expect(snap.entitled_claim_weekday).toBe(dec);
  });
});

describe("finalizationRateParams — snapshot wins over live truck", () => {
  it("pays at the assignment-time snapshot even after a mid-flight rate edit", () => {
    const params = finalizationRateParams({
      ...TRUCK_AT_ASSIGNMENT, // trip's snapshot fields
      truck: TRUCK_AFTER_EDIT, // live truck row, already edited
    });
    expect(params).toEqual({
      entitled_claim_weekday: 11,
      entitled_claim_offpeak: 13,
      daily_deduction_points: 2,
    });
  });

  it("falls back to the live truck for pre-migration trips (null snapshot)", () => {
    const params = finalizationRateParams({
      entitled_claim_weekday: null,
      entitled_claim_offpeak: null,
      daily_deduction_points: null,
      truck: TRUCK_AFTER_EDIT,
    });
    expect(params).toEqual({
      entitled_claim_weekday: 12,
      entitled_claim_offpeak: 14,
      daily_deduction_points: 3,
    });
  });

  it("converts Decimal-like snapshot values to numbers for the engine", () => {
    const params = finalizationRateParams({
      entitled_claim_weekday: { toString: () => "11.00" },
      entitled_claim_offpeak: { toString: () => "13.00" },
      daily_deduction_points: 2,
      truck: TRUCK_AFTER_EDIT,
    });
    expect(params.entitled_claim_weekday).toBe(11);
    expect(params.entitled_claim_offpeak).toBe(13);
  });
});

describe("buildPointsByZone — deterministic regardless of DB row order", () => {
  // K2 legitimately has two location rows sharing one zone (spec sheet).
  const rows = [
    { zone_code: "K2", location_name: "Sungai Petani", points: 4 },
    { zone_code: "A2", location_name: "Ipoh", points: 6 },
    { zone_code: "K2", location_name: "Kuala Ketil", points: 4 },
    { zone_code: null, location_name: "Unzoned example", points: 8 }, // defensive: a null zone_code row is never mapped
  ];

  it("maps each zone once and skips null-zone rows", () => {
    const m = buildPointsByZone(rows);
    expect(m.get("K2")).toBe(4);
    expect(m.get("A2")).toBe(6);
    expect(m.size).toBe(2);
  });

  it("resolves same-zone twins identically whatever order the DB returns them", () => {
    // Simulate the historical twin drift ("Penang" edited, "Penang Island" not):
    // the winner must be the same for every permutation of row order.
    const twins = [
      { zone_code: "P1", location_name: "Penang", points: 3 },
      { zone_code: "P1", location_name: "Penang Island", points: 5 },
    ];
    const forward = buildPointsByZone(twins).get("P1");
    const reversed = buildPointsByZone([...twins].reverse()).get("P1");
    expect(forward).toBe(reversed); // order-independent — no coin flip
  });
});

describe("dropZonePoints — snapshot wins over live zone points", () => {
  it("uses the stop's assignment-time snapshot over the live points", () => {
    expect(dropZonePoints({ zone_points: 6 }, 7)).toBe(6);
  });

  it("falls back to live points for pre-migration stops", () => {
    expect(dropZonePoints({ zone_points: null }, 6)).toBe(6);
  });

  it("THROWS ZONE_POINTS_MISSING when the zone is unknown everywhere (never a silent 1-point pay)", () => {
    try {
      dropZonePoints({ zone_points: null }, undefined, "ZZ");
      expect.unreachable("expected ZONE_POINTS_MISSING");
    } catch (err) {
      const e = err as { code?: string; statusCode?: number; message?: string };
      expect(e.code).toBe("ZONE_POINTS_MISSING");
      expect(e.statusCode).toBe(422);
      expect(e.message).toContain("ZZ");
    }
  });
});

describe("end-to-end rate lock through the engine", () => {
  // Weekday Ipoh trip, assigned at rate 11 / deduction 2 (the RM44 anchor),
  // then the admin edits PLX 2406 to rate 12 / deduction 3 before completion.
  const pickup = new Date("2026-07-01T02:00:00Z"); // Wed 10:00 MYT

  it("still pays the RM44 anchor from the snapshot after a mid-flight edit", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: pickup, // delivered same MYT day-part as pickup in this scenario
      drops: [{ zoneCode: "A2", zonePoints: dropZonePoints({ zone_points: 6 }, 6) }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: finalizationRateParams({ ...TRUCK_AT_ASSIGNMENT, truck: TRUCK_AFTER_EDIT }),
    });
    expect(r.incentiveThisTrip).toBe(44); // (6−2)×11, NOT (6−3)×12
  });

  it("a trip assigned AFTER the edit pays at the new rate", () => {
    const r = calculateDeliveryIncentive({
      publicHolidays: NO_HOLIDAYS,
      rateDateTime: pickup, // delivered same MYT day-part as pickup in this scenario
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      truck: finalizationRateParams({ ...truckRateSnapshot(TRUCK_AFTER_EDIT), truck: TRUCK_AFTER_EDIT }),
    });
    expect(r.incentiveThisTrip).toBe(36); // (6−3)×12
  });
});
