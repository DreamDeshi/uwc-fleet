import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  calculateDeliveryIncentive,
  OFFPEAK_CUTOFF_HOUR,
  PEAK_START_HOUR,
} from "../src/services/incentiveEngine";

/**
 * Two boundary behaviours the other incentive tests don't pin exactly:
 *   1. The peak/off-peak cutoff EDGE (17:59 vs 18:00 MYT). A boundary bug here
 *      would systematically mis-pay every ~6pm delivery, so the exact hour the
 *      tier flips is worth locking.
 *   2. The daily deduction on a MULTI-stop trip: it comes off the day's TOTAL
 *      points, floored at 0 (workbook rule) — a low-point FIRST drop carries its
 *      excess deduction to the rest of the day, it is not lost.
 *
 * ⚠ CORRECTED 2026-07-16: item 2's tests previously asserted a BUG — the
 * deduction floored on the FIRST DROP only, dropping the unused remainder (they
 * expected RM66 / RM11 / RM55). The authoritative workbook (INTERNAL LORRY RATE,
 * "accumulate TOTAL 20 point/day → 18, minus 2") deducts from the day TOTAL, so
 * the corrected expectations are RM55 / RM0 / RM0. See the engine + the fix in
 * incentive.test.ts's "daily deduction folds into the DAY TOTAL" block.
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

/**
 * The MORNING edge of the weekday peak band (regression, 17 Jul 2026).
 *
 * The workbook's peak table is headed "Weekday 8am - 6pm" and is one of only
 * two rate tables, so a weekday hour outside 8am–6pm is priced by the other
 * one (off-peak) — including 00:00–07:59, which the engine used to call PEAK
 * because it only tested `hour >= 18`. That underpaid every early-morning
 * delivery confirm (off-peak is the higher rate on most lorries), and the
 * 02:00 pickup window (item 12) makes those hours routine rather than rare.
 */
describe("isOffPeak — the morning edge of the weekday peak band (MYT)", () => {
  it("defaults the peak start to 08:00 (8am)", () => {
    expect(PEAK_START_HOUR).toBe(8);
  });

  it("is OFF-PEAK in the last minute before the peak band opens (07:59 weekday)", () => {
    expect(isOffPeak(mytWeekday(PEAK_START_HOUR - 1, 59), NO_HOLIDAYS)).toBe(true);
  });

  it("flips to PEAK exactly AT the peak start hour (08:00 weekday)", () => {
    // The peak band is inclusive at its start: [08:00, 18:00).
    expect(isOffPeak(mytWeekday(PEAK_START_HOUR, 0), NO_HOLIDAYS)).toBe(false);
  });

  it("stays PEAK just after the peak band opens (08:01 weekday)", () => {
    expect(isOffPeak(mytWeekday(PEAK_START_HOUR, 1), NO_HOLIDAYS)).toBe(false);
  });

  it("is OFF-PEAK at 07:00 weekday — the hour the operating window opens", () => {
    expect(isOffPeak(mytWeekday(7, 0), NO_HOLIDAYS)).toBe(true);
  });

  it("is OFF-PEAK at 02:00 weekday — the latest pickup the window now allows (item 12)", () => {
    expect(isOffPeak(mytWeekday(2, 0), NO_HOLIDAYS)).toBe(true);
  });

  it("is OFF-PEAK at midnight exactly (00:00 weekday)", () => {
    expect(isOffPeak(mytWeekday(0, 0), NO_HOLIDAYS)).toBe(true);
  });

  it("prices EVERY weekday hour exactly once: off-peak iff outside [08:00, 18:00)", () => {
    // The two workbook tables must partition the day — no hour unpriced, none
    // priced twice. This is the property the old `hour >= 18` check violated.
    for (let hour = 0; hour < 24; hour++) {
      const expectedOffPeak = hour < PEAK_START_HOUR || hour >= OFFPEAK_CUTOFF_HOUR;
      expect(isOffPeak(mytWeekday(hour, 0), NO_HOLIDAYS), `hour ${hour}:00`).toBe(expectedOffPeak);
      expect(isOffPeak(mytWeekday(hour, 59), NO_HOLIDAYS), `hour ${hour}:59`).toBe(expectedOffPeak);
    }
  });
});

describe("calculateDeliveryIncentive — the early-morning rate tier (money impact)", () => {
  it("pays the OFF-PEAK rate for a 00:30 delivery confirm on a late-running weekday run", () => {
    // The bug this pins: rateDateTime is the DELIVERY-confirm anchor, so a
    // driver closing an evening run just after midnight used to be paid the
    // PEAK RM11 instead of the off-peak RM13 — a real underpay, reachable
    // before item 12 and routine after it.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(0, 30),
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.isOffPeak).toBe(true);
    expect(r.rateUsed).toBe(13); // off-peak, NOT the RM11 weekday rate
    expect(r.incentiveThisTrip).toBe(13); // (3 − 2) × 13
  });

  it("still pays the PEAK rate for the same run confirmed at 08:00", () => {
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(8, 0),
      drops: [{ zoneCode: "K1", zonePoints: 3 }],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.isOffPeak).toBe(false);
    expect(r.rateUsed).toBe(11);
    expect(r.incentiveThisTrip).toBe(11); // (3 − 2) × 11
  });
});

describe("calculateDeliveryIncentive — daily deduction off the DAY TOTAL, floored at 0", () => {
  it("a low-point first drop carries the deduction across the day: [P2 1, A2 6] → (7−2)×11 = RM55", () => {
    // CORRECTED (was RM66, which encoded the bug): the old code floored the first
    // drop (1 − 2 → 0) and kept A2's 6 in full. The workbook deducts from the day
    // TOTAL: (1 + 6 − 2) × 11 = RM55.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "A2", zonePoints: 6 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.isOffPeak).toBe(false);
    expect(r.rateUsed).toBe(11);
    expect(r.dropPoints).toEqual([1, 6]);
    expect(r.wasRepeat).toEqual([false, false]);
    expect(r.deductionApplied).toBe(2); // the FULL 2-pt deduction, off the day total
    expect(r.incentiveThisTrip).toBe(55); // (1 + 6 − 2) × 11
  });

  it("the whole deduction applies to the day total: [P2 1, P2 repeat 1] = 2 pts − deduction 2 → RM0", () => {
    // CORRECTED (was RM11, which encoded the bug): total day points = 1 + 1 = 2;
    // minus the 2-pt deduction = 0. The leftover deduction is NOT dropped — it
    // applies to the day total, exactly as the workbook's "20 → 18 (minus 2)".
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "P2", zonePoints: 1 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: PLX,
    });
    expect(r.dropPoints).toEqual([1, 1]);
    expect(r.wasRepeat).toEqual([false, true]);
    expect(r.deductionApplied).toBe(2); // both points absorbed by the deduction
    expect(r.incentiveThisTrip).toBe(0);
  });

  it("never yields negative pay: an oversized deduction (10) vs a 6-point day → RM0", () => {
    // CORRECTED (was RM55, which encoded the bug): the deduction is capped by
    // flooring the day TOTAL at 0, so a 10-pt deduction against 6 points pays 0
    // (never negative) and does NOT leave later drops untouched.
    const r = calculateDeliveryIncentive({
      rateDateTime: mytWeekday(12, 0),
      drops: [
        { zoneCode: "P2", zonePoints: 1 },
        { zoneCode: "A1", zonePoints: 5 },
      ],
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: { ...PLX, daily_deduction_points: 10 },
    });
    expect(r.deductionApplied).toBe(6); // all 6 points absorbed
    expect(r.incentiveThisTrip).toBe(0); // max(6 − 10, 0) × 11
    expect(r.incentiveThisTrip).toBeGreaterThanOrEqual(0);
  });
});
