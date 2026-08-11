import { describe, it, expect } from "vitest";
import {
  isInterplantRouteType,
  INTERPLANT_FALLBACK_RATE,
  loadSpecTrucks,
} from "../src/lib/uwcSpec";
import { truckRateSnapshot, finalizationRateParams } from "../src/services/rateSnapshot";
import { effectiveTruckRates } from "../src/services/pendingRates";
import { priorDeliveredDropsWhere } from "../src/services/dayLedger";
import { calculateDeliveryIncentive } from "../src/services/incentiveEngine";

/**
 * A3 (Mr. Teh, R5 2026-08-11): a lorry doing a plant run is paid INTERPLANT
 * pay — "CHANGE TO INTERPLANT PAY" — not its own customer/supplier rate.
 *
 * The workbook (INTERNAL LORRY RATE, INTER PLANT block, 28 Jul revision) prices
 * interplant work at PLX 2406 RM6 weekday / RM8 off-peak and PPE 2406 RM5 / RM7,
 * with NO daily deduction column — while the customer/supplier tables above it
 * price the SAME PLX 2406 at RM11 / RM13 with a 2-point deduction.
 *
 * Every test below fails if the interplant branch of truckRateSnapshot is
 * removed: the trip falls back to the customer pair, which is exactly the bug.
 */

// A weekday inside the peak window (Mon 2026-08-10, 10:00 MYT = 02:00Z).
const WEEKDAY = new Date("2026-08-10T02:00:00Z");
// Sunday → off-peak tier (2026-08-09).
const SUNDAY = new Date("2026-08-09T02:00:00Z");
const NO_HOLIDAYS = new Set<string>();

// PLX 2406 as it stands in the DB after reset-to-spec: BOTH pairs present.
const PLX = {
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
  interplant_claim_weekday: 6,
  interplant_claim_offpeak: 8,
};

// PPE 2406 — the OTHER designated interplant lorry, and the only fixture whose
// own interplant pair DIFFERS from INTERPLANT_FALLBACK_RATE (RM5/7 vs RM6/8).
// That difference is the whole point of this fixture: PLX 2406's own pair IS
// the fallback, so a test using only PLX cannot tell "reads the truck's pair"
// apart from "always uses the fallback". See the test that pins it below.
const PPE = {
  entitled_claim_weekday: 5,
  entitled_claim_offpeak: 7,
  daily_deduction_points: 0,
  interplant_claim_weekday: 5,
  interplant_claim_offpeak: 7,
};

// PND 1888 — a customer lorry with no interplant row of its own.
const PND = {
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
  interplant_claim_weekday: null,
  interplant_claim_offpeak: null,
};

describe("isInterplantRouteType", () => {
  it("matches the two seeded interplant route-type names", () => {
    expect(isInterplantRouteType("Inter-Plant Delivery")).toBe(true);
    expect(isInterplantRouteType("Inter-Plant Return")).toBe(true);
  });

  it("does NOT match the four customer/supplier route types", () => {
    for (const name of [
      "Customer Delivery",
      "Customer Return",
      "Supplier Delivery",
      "Supplier Return",
    ]) {
      expect(isInterplantRouteType(name)).toBe(false);
    }
  });

  it("tolerates punctuation and case, so a cosmetic rename cannot move money", () => {
    expect(isInterplantRouteType("Inter Plant Delivery")).toBe(true);
    expect(isInterplantRouteType("interplant return")).toBe(true);
    expect(isInterplantRouteType("INTER-PLANT DELIVERY")).toBe(true);
  });

  it("is false for a missing route type rather than throwing", () => {
    expect(isInterplantRouteType(null)).toBe(false);
    expect(isInterplantRouteType(undefined)).toBe(false);
    expect(isInterplantRouteType("")).toBe(false);
  });
});

describe("truckRateSnapshot — which of the truck's two rate pairs is frozen", () => {
  it("customer/supplier work freezes the customer pair and the deduction (unchanged behaviour)", () => {
    expect(truckRateSnapshot(PLX)).toEqual({
      entitled_claim_weekday: 11,
      entitled_claim_offpeak: 13,
      daily_deduction_points: 2,
    });
  });

  it("interplant work on PLX 2406 freezes RM6/8 and NO deduction", () => {
    expect(truckRateSnapshot(PLX, { interplant: true })).toEqual({
      entitled_claim_weekday: 6,
      entitled_claim_offpeak: 8,
      daily_deduction_points: 0,
    });
  });

  it("interplant work on a BACKUP lorry takes PLX 2406's pair, never its own customer rate", () => {
    // Owner ruling 11 Aug 2026: PLX 2406's row, the designated primary
    // interplant lorry and the higher of the two.
    expect(truckRateSnapshot(PND, { interplant: true })).toEqual({
      entitled_claim_weekday: INTERPLANT_FALLBACK_RATE.weekday,
      entitled_claim_offpeak: INTERPLANT_FALLBACK_RATE.offpeak,
      daily_deduction_points: 0,
    });
    // The thing that must never happen again: paying a plant run at RM11/13.
    expect(truckRateSnapshot(PND, { interplant: true }).entitled_claim_weekday).not.toBe(11);
  });

  it("a lorry WITH its own interplant row is paid THAT row, not the fallback", () => {
    // PPE 2406 is the discriminating case, and it is the ordinary case: one of
    // the two designated interplant lorries, priced RM5/7 by the workbook.
    //
    // ⚠ WHY THIS TEST EXISTS. Every other test here expects 6/8 — PLX 2406's
    // own pair IS the fallback, and a backup lorry resolves TO the fallback. So
    // the suite passed 1254/1254 with `truck.interplant_claim_weekday ??` deleted
    // and the fallback returned unconditionally (measured 11 Aug 2026). It could
    // not see the difference between reading the truck's row and ignoring it.
    // This is the assertion that goes red for that, and RM1 per point — paid on
    // the wrong side, uncorrectable after approval (BL9) — is what it protects.
    expect(truckRateSnapshot(PPE, { interplant: true })).toEqual({
      entitled_claim_weekday: 5,
      entitled_claim_offpeak: 7,
      daily_deduction_points: 0,
    });

    // Said the other way round, so a future edit to the fallback cannot quietly
    // make this test tautological: PPE's pair must NOT be the fallback's.
    expect(truckRateSnapshot(PPE, { interplant: true }).entitled_claim_weekday).not.toBe(
      INTERPLANT_FALLBACK_RATE.weekday
    );
    expect(truckRateSnapshot(PPE, { interplant: true }).entitled_claim_offpeak).not.toBe(
      INTERPLANT_FALLBACK_RATE.offpeak
    );
  });

  it("pins the two interplant lorries to the DB values the backfill writes", () => {
    // The spec is the source; 20260811160000_interplant_rate_values writes these
    // exact pairs onto existing databases, where the columns landed null. If the
    // spec moves and the migration does not, this fails.
    const spec = loadSpecTrucks();
    const plx = spec.find((t) => t.plate === "PLX 2406")!;
    const ppe = spec.find((t) => t.plate === "PPE 2406")!;

    expect(truckRateSnapshot(PLX, { interplant: true })).toMatchObject({
      entitled_claim_weekday: plx.interplant_weekday_rate,
      entitled_claim_offpeak: plx.interplant_offpeak_rate,
    });
    expect(truckRateSnapshot(PPE, { interplant: true })).toMatchObject({
      entitled_claim_weekday: ppe.interplant_weekday_rate,
      entitled_claim_offpeak: ppe.interplant_offpeak_rate,
    });
  });

  it("passes the interplant pair through the next-day cutoff merge untouched", () => {
    // A staged customer-rate edit that has MATURED must not disturb the
    // interplant pair, which has no pending twin.
    const staged = {
      ...PLX,
      pending_claim_weekday: 12,
      pending_claim_offpeak: 14,
      pending_deduction_points: 3,
      pending_rates_effective: "2026-08-09",
    };
    const snap = truckRateSnapshot(effectiveTruckRates(staged, WEEKDAY), { interplant: true });
    expect(snap).toEqual({
      entitled_claim_weekday: 6,
      entitled_claim_offpeak: 8,
      daily_deduction_points: 0,
    });
  });
});

describe("what an interplant trip actually pays", () => {
  // One Batu Kawan (P2) drop, worth 1 point in both workbook tables.
  const oneDropAtBatuKawan = {
    drops: [{ zoneCode: "P2", zonePoints: 1 }],
    zonesDeliveredEarlierToday: [],
    priorPointsToday: 0,
    publicHolidays: NO_HOLIDAYS,
  };

  it("pays the interplant rate, not the customer rate: RM6 rather than RM11", () => {
    const interplant = calculateDeliveryIncentive({
      ...oneDropAtBatuKawan,
      rateDateTime: WEEKDAY,
      truck: finalizationRateParams({
        ...truckRateSnapshot(PLX, { interplant: true }),
        truck: PLX,
      }),
    });
    expect(interplant.incentiveThisTrip).toBe(6); // 1 point x RM6

    // The same trip before this change — the live defect, kept as the contrast.
    const asCustomerWork = calculateDeliveryIncentive({
      ...oneDropAtBatuKawan,
      rateDateTime: WEEKDAY,
      truck: finalizationRateParams({ ...truckRateSnapshot(PLX), truck: PLX }),
    });
    expect(asCustomerWork.incentiveThisTrip).toBe(0); // 1 point − 2 deduction, floored
  });

  it("takes the off-peak interplant rate on a Sunday: RM8", () => {
    const r = calculateDeliveryIncentive({
      ...oneDropAtBatuKawan,
      rateDateTime: SUNDAY,
      truck: finalizationRateParams({
        ...truckRateSnapshot(PLX, { interplant: true }),
        truck: PLX,
      }),
    });
    expect(r.incentiveThisTrip).toBe(8);
  });

  it("takes NO daily deduction — the deduction never eats an interplant point", () => {
    // The contrast test above is the proof this matters: on the customer pair
    // the same single point is wiped out entirely by the 2-point deduction.
    const r = calculateDeliveryIncentive({
      ...oneDropAtBatuKawan,
      rateDateTime: WEEKDAY,
      truck: finalizationRateParams({
        ...truckRateSnapshot(PLX, { interplant: true }),
        truck: PLX,
      }),
    });
    expect(r.incentiveThisTrip).toBeGreaterThan(0);
  });
});

describe("the rate follows the ROUTE TYPE, both directions", () => {
  // R5 A2 is Option B: a round trip is TWO bookings, an Inter-Plant Delivery
  // out and an Inter-Plant Return back. A matcher that caught only the Delivery
  // leg would leave every Return leg snapshotting the customer rate — the same
  // defect, surviving on half the legs, and invisible to any test that only
  // ever exercises the outbound direction.
  const snapshotFor = (routeTypeName: string, truck = PLX) =>
    truckRateSnapshot(truck, { interplant: isInterplantRouteType(routeTypeName) });

  it("pays the interplant rate on the DELIVERY leg", () => {
    expect(snapshotFor("Inter-Plant Delivery")).toEqual({
      entitled_claim_weekday: 6,
      entitled_claim_offpeak: 8,
      daily_deduction_points: 0,
    });
  });

  it("pays the interplant rate on the RETURN leg too — the other half of the round trip", () => {
    expect(snapshotFor("Inter-Plant Return")).toEqual({
      entitled_claim_weekday: 6,
      entitled_claim_offpeak: 8,
      daily_deduction_points: 0,
    });
  });

  it("both legs of a round trip snapshot IDENTICAL pay", () => {
    expect(snapshotFor("Inter-Plant Delivery")).toEqual(snapshotFor("Inter-Plant Return"));
  });

  it("leaves all four customer/supplier route types on the customer pair", () => {
    for (const name of [
      "Customer Delivery",
      "Customer Return",
      "Supplier Delivery",
      "Supplier Return",
    ]) {
      expect(snapshotFor(name)).toEqual({
        entitled_claim_weekday: 11,
        entitled_claim_offpeak: 13,
        daily_deduction_points: 2,
      });
    }
  });
});

describe("the day-ledger pool split (mixed interplant + customer day)", () => {
  const dayStart = new Date("2026-08-10T16:00:00Z");
  const anchor = new Date("2026-08-10T02:30:00Z");
  const IP_IDS = ["rt-ip-delivery", "rt-ip-return"];
  const base = { driverId: "d1", excludeTripId: "tB", dayStart, anchor };

  it("a CUSTOMER finalize excludes every interplant trip from its ledger", () => {
    const where = priorDeliveredDropsWhere({
      ...base,
      interplantRouteTypeIds: IP_IDS,
      pool: "customer",
    });
    expect(where.trip.route_type_id).toEqual({ notIn: IP_IDS });
  });

  it("an INTERPLANT finalize sees only interplant trips", () => {
    const where = priorDeliveredDropsWhere({
      ...base,
      interplantRouteTypeIds: IP_IDS,
      pool: "interplant",
    });
    expect(where.trip.route_type_id).toEqual({ in: IP_IDS });
  });

  it("BOTH round-trip legs land in the same pool", () => {
    // Delivery and Return are both interplant ids, so leg 2 can see leg 1.
    const where = priorDeliveredDropsWhere({
      ...base,
      interplantRouteTypeIds: IP_IDS,
      pool: "interplant",
    });
    expect(where.trip.route_type_id).toEqual({ in: ["rt-ip-delivery", "rt-ip-return"] });
  });

  it("degrades to single-pool behaviour when no interplant route types exist", () => {
    const where = priorDeliveredDropsWhere({
      ...base,
      interplantRouteTypeIds: [],
      pool: "customer",
    });
    // `notIn: []` matches every trip — exactly what the ledger did before
    // interplant pay existed.
    expect(where.trip.route_type_id).toEqual({ notIn: [] });
  });

  it("THE MONEY: a shared pool would have swallowed the customer deduction", () => {
    // The arithmetic this split exists to prevent, spelled out.
    // Morning interplant leg: 1 pt at Batu Kawan (P2), deduction 0.
    // Afternoon customer run to Ipoh: 6 pts, deduction 2, rate RM11.
    const ipohAfternoon = {
      rateDateTime: WEEKDAY,
      drops: [{ zoneCode: "A2", zonePoints: 6 }],
      zonesDeliveredEarlierToday: [] as string[],
      publicHolidays: NO_HOLIDAYS,
      truck: finalizationRateParams({ ...truckRateSnapshot(PLX), truck: PLX }),
    };

    // SEPARATE pools (what ships): the interplant point is invisible here, so
    // the customer side takes its own deduction — (6 − 2) x RM11.
    const separate = calculateDeliveryIncentive({ ...ipohAfternoon, priorPointsToday: 0 });
    expect(separate.incentiveThisTrip).toBe(44);

    // SHARED pool (the bug): the morning interplant point pre-loads `prior`, and
    // the telescoping fold — max(prior+group−ded,0) − max(prior−ded,0) — then
    // spends a deduction that the deduction-0 interplant trip never paid.
    const shared = calculateDeliveryIncentive({ ...ipohAfternoon, priorPointsToday: 1 });
    expect(shared.incentiveThisTrip).toBe(55);

    // RM11 a day, overpaid, and unrecoverable once the trip is approved.
    expect(shared.incentiveThisTrip - separate.incentiveThisTrip).toBe(11);
  });
});

describe("the spec data behind the rates", () => {
  it("carries the workbook's INTER PLANT block for exactly the two interplant trucks", () => {
    const trucks = loadSpecTrucks();
    const withInterplant = trucks.filter((t) => t.interplant_weekday_rate != null);
    expect(withInterplant.map((t) => t.plate).sort()).toEqual(["PLX 2406", "PPE 2406"]);

    const plx = trucks.find((t) => t.plate === "PLX 2406")!;
    expect([plx.interplant_weekday_rate, plx.interplant_offpeak_rate]).toEqual([6, 8]);
    // ...while its CUSTOMER pair stays RM11/13: the same truck, two rates.
    expect([plx.weekday_rate, plx.offpeak_rate]).toEqual([11, 13]);

    const ppe = trucks.find((t) => t.plate === "PPE 2406")!;
    expect([ppe.interplant_weekday_rate, ppe.interplant_offpeak_rate]).toEqual([5, 7]);
  });

  it("keeps the fallback equal to PLX 2406's interplant row (owner ruling 11 Aug)", () => {
    const plx = loadSpecTrucks().find((t) => t.plate === "PLX 2406")!;
    expect(INTERPLANT_FALLBACK_RATE.weekday).toBe(plx.interplant_weekday_rate);
    expect(INTERPLANT_FALLBACK_RATE.offpeak).toBe(plx.interplant_offpeak_rate);
  });
});
