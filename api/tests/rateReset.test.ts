import { describe, it, expect } from "vitest";
import { planRateReset, type DbTruckRates } from "../src/services/rateReset";
import type { SpecTruck } from "../src/lib/uwcSpec";

// Minimal spec trucks mirroring docs/uwc-spec.json's shape (type/priority_zones
// are irrelevant to the rate reset but required by the SpecTruck type).
const PLX: SpecTruck = {
  plate: "PLX 2406",
  type: "10t-30ft",
  max_pallets: 16,
  weekday_rate: 11,
  offpeak_rate: 13,
  daily_deduction: 2,
  priority_zones: ["A1", "A2", "P1", "P2"],
};
const PND: SpecTruck = {
  plate: "PND 1888",
  type: "10t-30ft",
  max_pallets: 14,
  weekday_rate: 11,
  offpeak_rate: 13,
  daily_deduction: 2,
  priority_zones: ["P1", "P2", "P3", "K1", "K2"],
};

// A DB row already exactly at spec for a given truck.
function atSpec(t: SpecTruck): DbTruckRates {
  return {
    plate: t.plate,
    entitled_claim_weekday: t.weekday_rate,
    entitled_claim_offpeak: t.offpeak_rate,
    daily_deduction_points: t.daily_deduction,
    max_pallets: t.max_pallets,
  };
}

describe("planRateReset", () => {
  it("restores a truck drifted from spec (PLX weekday 12 → 11)", () => {
    const db = [{ ...atSpec(PLX), entitled_claim_weekday: 12 }]; // live drift
    const plan = planRateReset([PLX], db);

    expect(plan.updated).toHaveLength(1);
    const u = plan.updated[0];
    expect(u.plate).toBe("PLX 2406");
    expect(u.data.entitled_claim_weekday).toBe(11); // restored to spec
    expect(u.changes).toEqual([{ field: "entitled_claim_weekday", from: 12, to: 11 }]);
    expect(plan.alreadyAtSpec).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("leaves a truck already at spec unchanged", () => {
    const plan = planRateReset([PLX], [atSpec(PLX)]);
    expect(plan.updated).toEqual([]);
    expect(plan.alreadyAtSpec).toEqual(["PLX 2406"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a spec plate that is missing from the DB (never creates it)", () => {
    // DB has only PLX; spec also lists PND → PND is skipped, not created.
    const plan = planRateReset([PLX, PND], [atSpec(PLX)]);
    expect(plan.skipped).toEqual(["PND 1888"]);
    expect(plan.updated).toEqual([]);
    expect(plan.alreadyAtSpec).toEqual(["PLX 2406"]);
  });

  it("detects drift across all four fields and targets the full spec values", () => {
    const db: DbTruckRates[] = [
      {
        plate: "PLX 2406",
        entitled_claim_weekday: 12, // drift
        entitled_claim_offpeak: 14, // drift
        daily_deduction_points: 3, // drift
        max_pallets: 18, // drift
      },
    ];
    const plan = planRateReset([PLX], db);
    expect(plan.updated).toHaveLength(1);
    const u = plan.updated[0];
    expect(u.data).toEqual({
      entitled_claim_weekday: 11,
      entitled_claim_offpeak: 13,
      daily_deduction_points: 2,
      max_pallets: 16,
    });
    expect(u.changes.map((c) => c.field).sort()).toEqual([
      "daily_deduction_points",
      "entitled_claim_offpeak",
      "entitled_claim_weekday",
      "max_pallets",
    ]);
  });

  it("handles a mix: one drifted, one at spec, one missing", () => {
    const db = [{ ...atSpec(PND), daily_deduction_points: 5 }, atSpec(PLX)];
    // spec lists a third plate not in the DB.
    const PRH: SpecTruck = {
      plate: "PRH 5292",
      type: "1t",
      max_pallets: 2,
      weekday_rate: 9,
      offpeak_rate: 9,
      daily_deduction: 2,
      priority_zones: [],
    };
    const plan = planRateReset([PLX, PND, PRH], db);
    expect(plan.updated.map((u) => u.plate)).toEqual(["PND 1888"]);
    expect(plan.alreadyAtSpec).toEqual(["PLX 2406"]);
    expect(plan.skipped).toEqual(["PRH 5292"]);
  });
});
