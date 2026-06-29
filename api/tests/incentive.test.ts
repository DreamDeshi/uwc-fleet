import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  computeTripPoints,
  isDocumentationComplete,
  calculateIncentiveAmount,
  calculateDeliveryIncentive,
  getTripDayStart,
  getTripDayEnd,
} from "../src/services/incentiveEngine";

// Mohd Azmi's truck (PLX 2406): weekday RM11, off-peak RM13, deduction 2 pts.
const PLX2406 = { daily_deduction_points: 2, entitled_claim_weekday: 11, entitled_claim_offpeak: 13 };

// All dates below are written as explicit UTC instants (…Z); the comment gives
// the Malaysia-time (UTC+8) wall clock the engine actually evaluates against.
// This keeps the tests deterministic on any runner, including a UTC CI host.
describe("isOffPeak — evaluated in Malaysia time (UTC+8)", () => {
  it("treats Mon-Fri before 6pm MYT as weekday", () => {
    expect(isOffPeak(new Date("2026-06-24T03:00:00Z"))).toBe(false); // Wed 11am MYT
  });

  it("treats Mon-Fri at/after 6pm MYT as off-peak", () => {
    expect(isOffPeak(new Date("2026-06-24T10:30:00Z"))).toBe(true); // Wed 6:30pm MYT
    expect(isOffPeak(new Date("2026-06-24T15:00:00Z"))).toBe(true); // Wed 11pm MYT
  });

  it("treats Saturday and Sunday (MYT) as off-peak regardless of time", () => {
    expect(isOffPeak(new Date("2026-06-20T01:00:00Z"))).toBe(true); // Sat 9am MYT
    expect(isOffPeak(new Date("2026-06-21T01:00:00Z"))).toBe(true); // Sun 9am MYT
  });

  it("uses MYT not server UTC: 10:30 UTC on a weekday is 6:30pm MYT → off-peak", () => {
    // On the old (UTC-host) code this read as 10:30am and wrongly billed weekday.
    expect(isOffPeak(new Date("2026-06-24T10:30:00Z"))).toBe(true);
  });
});

describe("isOffPeak — public holidays use the off-peak table (Fix 3)", () => {
  it("treats a weekday public holiday at noon as off-peak", () => {
    // 2026-05-01 (Labour Day) is a Friday; noon MYT = 04:00 UTC.
    expect(isOffPeak(new Date("2026-05-01T04:00:00Z"))).toBe(true);
  });

  it("a normal (non-holiday) weekday at the same time is NOT off-peak", () => {
    expect(isOffPeak(new Date("2026-06-24T04:00:00Z"))).toBe(false); // Wed noon MYT
  });
});

describe("getTripDayStart / getTripDayEnd — trip-day binning in MYT (Fix 2)", () => {
  it("bins 00:30 and 23:30 of the same MYT day into the same trip-day", () => {
    const early = new Date("2026-06-21T16:30:00Z"); // 2026-06-22 00:30 MYT
    const late = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    expect(getTripDayStart(early).getTime()).toBe(getTripDayStart(late).getTime());
  });

  it("puts 23:30 MYT and 00:30 MYT the next day into different trip-days", () => {
    const lateNight = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    const afterMidnight = new Date("2026-06-22T16:30:00Z"); // 2026-06-23 00:30 MYT
    expect(getTripDayStart(lateNight).getTime()).not.toBe(getTripDayStart(afterMidnight).getTime());
  });

  it("returns midnight MYT (16:00 UTC previous day) as the start, end = +24h", () => {
    const t = new Date("2026-06-22T15:30:00Z"); // 2026-06-22 23:30 MYT
    const start = getTripDayStart(t);
    expect(start.toISOString()).toBe("2026-06-21T16:00:00.000Z"); // 2026-06-22 00:00 MYT
    expect(getTripDayEnd(t).getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("computeTripPoints — the first-trip-vs-1-point rule", () => {
  it("gives full destination points on the first trip of the day", () => {
    expect(computeTripPoints(1, 6)).toBe(6); // Ipoh = 6 pts
  });

  it("gives exactly 1 point on every later trip, regardless of destination", () => {
    expect(computeTripPoints(2, 6)).toBe(1);
    expect(computeTripPoints(3, 8)).toBe(1); // even KL (8 pts) only counts for 1 if not first
  });
});

describe("isDocumentationComplete — the documentation gate", () => {
  it("blocks when the DO photo is missing", () => {
    expect(isDocumentationComplete({ do_uploaded: false, k2_form_ack: true }, "P1")).toBe(false);
  });

  it("passes for non-K2 zones once the DO photo is uploaded", () => {
    expect(isDocumentationComplete({ do_uploaded: true, k2_form_ack: false }, "P1")).toBe(true);
  });

  it("requires the K2 form ack only when destination zone is K2", () => {
    expect(isDocumentationComplete({ do_uploaded: true, k2_form_ack: false }, "K2")).toBe(false);
    expect(isDocumentationComplete({ do_uploaded: true, k2_form_ack: true }, "K2")).toBe(true);
  });
});

describe("calculateIncentiveAmount — deduction + rate", () => {
  it("applies each truck class's daily deduction before multiplying by rate", () => {
    expect(calculateIncentiveAmount({ totalPointsToday: 8, dailyDeductionPoints: 2, rate: 11 })).toBe(66); // 30ft lorry
    expect(calculateIncentiveAmount({ totalPointsToday: 8, dailyDeductionPoints: 3, rate: 10 })).toBe(50); // 17.5ft lorry
  });

  it("never goes negative when deduction exceeds points earned", () => {
    expect(calculateIncentiveAmount({ totalPointsToday: 1, dailyDeductionPoints: 3, rate: 10 })).toBe(0);
  });
});

describe("calculateDeliveryIncentive — full worked example from the brief", () => {
  // Mohd Azmi, PLX 2406, weekday.
  // Trip 1: Ipoh (A2) = 6 pts. Trip 2: Kulim = 1 pt (not first). Trip 3: Penang = 1 pt (not first).
  // Total = 8 pts - 2 (deduction) = 6 pts. Incentive = 6 x RM11 = RM66.
  const weekdayMorning = new Date("2026-06-22T01:00:00Z"); // Monday 9am MYT

  it("trip 1 of the day earns full destination points", () => {
    const result = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 6, // Ipoh
      completedTripsTodayBeforeThis: 0,
      firstTripPointsToday: null,
      truck: PLX2406,
    });
    expect(result.sequenceNumberToday).toBe(1);
    expect(result.pointsEarnedThisTrip).toBe(6);
    expect(result.totalPointsToday).toBe(6);
    expect(result.incentiveAmount).toBe(44); // (6 - 2) x 11
  });

  it("trip 2 of the day earns 1 point and accumulates onto trip 1's total", () => {
    const result = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 3, // Kulim — ignored, not the first trip
      completedTripsTodayBeforeThis: 1,
      firstTripPointsToday: 6, // trip 1 earned 6 (Ipoh)
      truck: PLX2406,
    });
    expect(result.sequenceNumberToday).toBe(2);
    expect(result.pointsEarnedThisTrip).toBe(1);
    expect(result.totalPointsToday).toBe(7);
    expect(result.incentiveAmount).toBe(55); // (7 - 2) x 11
  });

  it("trip 3 of the day matches the brief's worked example exactly: RM66", () => {
    const result = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 3, // Penang — ignored, not the first trip
      completedTripsTodayBeforeThis: 2,
      firstTripPointsToday: 6,
      truck: PLX2406,
    });
    expect(result.sequenceNumberToday).toBe(3);
    expect(result.pointsEarnedThisTrip).toBe(1);
    expect(result.totalPointsToday).toBe(8);
    expect(result.incentiveAmount).toBe(66);
    expect(result.isOffPeak).toBe(false);
    expect(result.rateUsed).toBe(11);
  });

  it("uses the off-peak rate when the trip's pickup time is after the cutoff", () => {
    const result = calculateDeliveryIncentive({
      pickupDateTime: new Date("2026-06-22T11:00:00Z"), // Monday 7pm MYT — after 6pm cutoff
      destinationPoints: 6,
      completedTripsTodayBeforeThis: 0,
      firstTripPointsToday: null,
      truck: PLX2406,
    });
    expect(result.isOffPeak).toBe(true);
    expect(result.rateUsed).toBe(13);
    expect(result.incentiveAmount).toBe(52); // (6 - 2) x 13
  });

  it("applies each truck's own deduction (17.5ft lorry: 3 pts)", () => {
    const truck17_5ft = { daily_deduction_points: 3, entitled_claim_weekday: 10, entitled_claim_offpeak: 10 };
    const result = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 4, // Kuala Ketil
      completedTripsTodayBeforeThis: 0,
      firstTripPointsToday: null,
      truck: truck17_5ft,
    });
    expect(result.totalPointsToday).toBe(4);
    expect(result.incentiveAmount).toBe(10); // (4 - 3) x 10
  });
});

describe("calculateDeliveryIncentive — per-trip marginal incentiveThisTrip (Fix 1)", () => {
  // Same worked example: Ipoh (6) → Kulim (1) → Penang (1), PLX 2406, weekday.
  // incentive_earned now stores the MARGINAL value, so the three stored values
  // must SUM to the correct day total (66) instead of the inflated running
  // cumulative (44 + 55 + 66 = 165).
  const weekdayMorning = new Date("2026-06-22T01:00:00Z"); // Monday 9am MYT

  it("marginals sum to the day total and equal the final cumulative", () => {
    const trip1 = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 6, // Ipoh
      completedTripsTodayBeforeThis: 0,
      firstTripPointsToday: null,
      truck: PLX2406,
    });
    const trip2 = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 3, // ignored — not the first trip
      completedTripsTodayBeforeThis: 1,
      firstTripPointsToday: 6,
      truck: PLX2406,
    });
    const trip3 = calculateDeliveryIncentive({
      pickupDateTime: weekdayMorning,
      destinationPoints: 3, // ignored — not the first trip
      completedTripsTodayBeforeThis: 2,
      firstTripPointsToday: 6,
      truck: PLX2406,
    });

    // Trip 1 absorbs the whole-day deduction (44); each later trip adds 1 pt × RM11.
    expect(trip1.incentiveThisTrip).toBe(44);
    expect(trip2.incentiveThisTrip).toBe(11);
    expect(trip3.incentiveThisTrip).toBe(11);

    const sumOfMarginals =
      trip1.incentiveThisTrip + trip2.incentiveThisTrip + trip3.incentiveThisTrip;
    expect(sumOfMarginals).toBe(66); // the correct day total
    expect(sumOfMarginals).toBe(trip3.incentiveAmount); // == the old cumulative on the last trip

    // The cumulative field is preserved unchanged so existing callers/tests still pass.
    expect(trip1.incentiveAmount).toBe(44);
    expect(trip2.incentiveAmount).toBe(55);
    expect(trip3.incentiveAmount).toBe(66);
  });
});
