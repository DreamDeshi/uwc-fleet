import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  calculateDeliveryIncentive,
  OFFPEAK_CUTOFF_HOUR,
} from "../src/services/incentiveEngine";

/**
 * Phase 1 (MONEY) — two boundary behaviours the existing incentive tests don't
 * pin exactly:
 *   1. The peak/off-peak cutoff EDGE (17:59 vs 18:00 MYT). A boundary bug here
 *      would systematically mis-pay every ~6pm delivery, so the exact hour the
 *      tier flips is worth locking.
 *   2. The zero-floor interaction with a MULTI-stop trip: the once-a-day
 *      deduction lands only on the day's first drop, floors at 0, and the
 *      unused remainder is NOT carried to later drops.
 *
 * These assert the engine's ACTUAL current behaviour (documented in
 * incentiveEngine.ts). No rule is changed.
 */

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

// A given wall-clock hour:minute in Malaysia time (UTC+8) on a fixed WEEKDAY
// (2026-07-15 is a Wednesday), expressed as the UTC instant the engine reads.
function mytWeekday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 6, 15, hour - 8, minute));
}

const PLX = {
  daily_deduction_points: 2,
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
};

describe("isOffPeak — the exact peak/off-peak cutoff edge (MYT)", () => {
  it("defaults the cutoff to 18:00 (6pm)", () => {
    expect(OFFPEAK_CUTOFF_HOUR).toBe(18);
  });

  it("is PEAK in the last minute before the cutoff hour (17:59 weekday)", () => {
    expect(isOffPeak(mytWeekday(OFFPEAK_CUTOFF_HOUR - 1, 59), NO_HOLIDAYS)).toBe(false);
  });

  it("flips to OFF-PEAK exactly AT the cutoff hour (18:00 weekday)", () => {
    // The cutoff is inclusive: off-peak applies AT/after the hour (env doc).
    expect(isOffPeak(mytWeekday(OFFPEAK_CUTOFF_HOUR, 0), NO_HOLIDAYS)).toBe(true);
  });

  it("stays OFF-PEAK just after the cutoff (18:01 weekday)", () => {
    expect(isOffPeak(mytWeekday(OFFPEAK_CUTOFF_HOUR, 1), NO_HOLIDAYS)).toBe(true);
  });

  it("is PEAK at midday on a plain weekday (sanity — not everything is off-peak)", () => {
    expect(isOffPeak(mytWeekday(12, 0), NO_HOLIDAYS)).toBe(false);
  });

  it("is OFF-PEAK all day on a weekend regardless of hour (2026-07-18 = Saturday)", () => {
    const satMidday = new Date(Date.UTC(2026, 6, 18, 12 - 8, 0));
    expect(isOffPeak(satMidday, NO_HOLIDAYS)).toBe(true);
  });
});

describe("calculateDeliveryIncentive — zero-floor across a MULTI-stop trip", () => {
  it("the deduction floors the FIRST drop at 0 and never touches later drops", () => {
    // Day's first trip, weekday midday (peak → RM11). Drops: P2 (1pt) then A2
    // (6pt). PLX deduction 2 lands on the first drop only: 1 − 2 → 0 (took 1),
    // A2 keeps its full 6 → 6×11 = RM66.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "A2", zonePoints: 6 },
      ],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.isOffPeak).toBe(false);
    expect(r.rateUsed).toBe(11);
    expect(r.dropPoints).toEqual([1, 6]);
    expect(r.wasRepeat).toEqual([false, false]);
    expect(r.deductionApplied).toBe(1); // only 1 of the 2 points could be taken
    expect(r.incentiveThisTrip).toBe(66); // 0×11 + 6×11
  });

  it("the unused deduction remainder is NOT carried to the next drop", () => {
    // Two drops into the SAME zone: first P2 (1pt) floors to 0 (took 1), the
    // repeat P2 scores 1 and pays in full — the leftover 1 deduction point is
    // dropped, not applied to the repeat. → 0×11 + 1×11 = RM11.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "P2", zonePoints: 1 },
      ],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.dropPoints).toEqual([1, 1]);
    expect(r.wasRepeat).toEqual([false, true]);
    expect(r.deductionApplied).toBe(1);
    expect(r.incentiveThisTrip).toBe(11);
  });

  it("never yields negative pay even when the deduction exceeds the first drop", () => {
    // Oversized deduction (10) vs a 1pt first drop: floors to 0, the second
    // drop is untouched, and the trip total is >= 0.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "A1", zonePoints: 5 },
      ],
      zonesDeliveredEarlierToday: [],
      isFirstDeliveredDropOfDay: true,
      publicHolidays: NO_HOLIDAYS,
      truck: { ...PLX, daily_deduction_points: 10 },
    });
    expect(r.deductionApplied).toBe(1);
    expect(r.incentiveThisTrip).toBe(55); // 0×11 + 5×11
    expect(r.incentiveThisTrip).toBeGreaterThanOrEqual(0);
  });
});
