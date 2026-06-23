import { describe, it, expect } from "vitest";
import {
  isOffPeak,
  computeTripPoints,
  isDocumentationComplete,
  calculateIncentiveAmount,
  calculateDeliveryIncentive,
} from "../src/services/incentiveEngine";

// Mohd Azmi's truck (PLX 2406): weekday RM11, off-peak RM13, deduction 2 pts.
const PLX2406 = { daily_deduction_points: 2, entitled_claim_weekday: 11, entitled_claim_offpeak: 13 };

describe("isOffPeak", () => {
  it("treats Mon-Fri before 6pm as weekday", () => {
    expect(isOffPeak(new Date("2026-06-22T10:00:00"))).toBe(false); // Monday 10am
  });

  it("treats Mon-Fri at/after 6pm as off-peak", () => {
    expect(isOffPeak(new Date("2026-06-22T18:00:00"))).toBe(true); // Monday 6pm
    expect(isOffPeak(new Date("2026-06-22T23:00:00"))).toBe(true); // Monday 11pm
  });

  it("treats Saturday and Sunday as off-peak regardless of time", () => {
    expect(isOffPeak(new Date("2026-06-20T09:00:00"))).toBe(true); // Saturday morning
    expect(isOffPeak(new Date("2026-06-21T09:00:00"))).toBe(true); // Sunday morning
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
  const weekdayMorning = new Date("2026-06-22T09:00:00"); // Monday

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
      pickupDateTime: new Date("2026-06-22T19:00:00"), // Monday 7pm — after 6pm cutoff
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
