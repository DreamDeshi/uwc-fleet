import { describe, it, expect } from "vitest";
import { calculateDeliveryIncentive } from "../src/services/incentiveEngine";

/**
 * R5 A2 (Mr. Teh, 11 Aug 2026) — INTERPLANT IS PAID IN WHOLE ROUND TRIPS.
 *
 * He chose Option B (a round trip is TWO bookings) and then priced it himself:
 *
 *   "if particular intercompany delivery 18points for that day, then he will get
 *    pay only for 9 points (18 divide by 2), if the interplant point is 17point
 *    for whole days, then he will only entitle for 8 points"
 *
 * So: the DAY's interplant points ÷ 2, FLOORED. 17 → 8, not 8.5 and not 9 — the
 * odd leg is an incomplete round trip and earns nothing yet. Counting at day
 * level is what removes the Delivery-to-Return pairing problem entirely.
 *
 * The interplant rate pair and the separate interplant day ledger are
 * interplantRate.test.ts's subject. This file is only about the halving.
 *
 * ⚠ WHAT DISCRIMINATES. Every test in the first two blocks fails if
 * `roundTripHalving` is ignored — they assert a payout STRICTLY LOWER than the
 * points scored. The customer-pool block is the negative control: it fails if
 * the halving ever leaks onto customer/supplier work, which is the expensive
 * direction (it would silently halve every driver's real pay).
 */

// Mon 2026-08-10, 10:00 MYT — weekday/peak tier.
const WEEKDAY = new Date("2026-08-10T02:00:00Z");
const NO_HOLIDAYS = new Set<string>();

// The interplant snapshot: PLX 2406's interplant pair, and NO deduction
// (workbook INTER PLANT block has no deduction column; R3 A4 "Interplant no
// need deduction").
const INTERPLANT_TRUCK = {
  entitled_claim_weekday: 6,
  entitled_claim_offpeak: 8,
  daily_deduction_points: 0,
};

/** `n` interplant legs, each a 1-point drop in P2 (Batu Kawan). */
const legs = (n: number) => Array.from({ length: n }, () => ({ zoneCode: "P2", zonePoints: 1 }));

const interplant = (params: { drops: ReturnType<typeof legs>; priorPointsToday: number }) =>
  calculateDeliveryIncentive({
    rateDateTime: WEEKDAY,
    drops: params.drops,
    // Interplant delivers to one zone all day, so every leg after the first is a
    // same-zone repeat — which scores 1, the same as P2's full value. The
    // halving, not the repeat rule, is what makes the arithmetic below.
    zonesDeliveredEarlierToday: params.priorPointsToday > 0 ? ["P2"] : [],
    priorPointsToday: params.priorPointsToday,
    publicHolidays: NO_HOLIDAYS,
    truck: INTERPLANT_TRUCK,
    roundTripHalving: true,
  });

describe("R5 A2 — his own two numbers", () => {
  it("18 points in a day pays 9", () => {
    const res = interplant({ drops: legs(18), priorPointsToday: 0 });
    expect(res.pointsThisTrip).toBe(18);
    expect(res.incentiveThisTrip).toBe(9 * 6);
    expect(res.roundTripShortfall).toBe(9);
  });

  it("17 points in a day pays 8 — FLOOR, because the odd leg is an incomplete round trip", () => {
    const res = interplant({ drops: legs(17), priorPointsToday: 0 });
    expect(res.pointsThisTrip).toBe(17);
    expect(res.incentiveThisTrip).toBe(8 * 6);
    // Not 8.5 × 6 = RM51, and not 9 × 6 = RM54.
    expect(res.incentiveThisTrip).not.toBe(8.5 * 6);
    expect(res.roundTripShortfall).toBe(9);
  });
});

/**
 * THE HALVING IS A DAY RULE, NOT A TRIP RULE — and it has to telescope, because
 * each leg is its own booking that finalizes on its own. Same shape as the daily
 * deduction: this group's pay = floor(dayTotal WITH it / 2) − floor(dayTotal
 * BEFORE it / 2), so the day's legs sum to floor(dayTotal / 2) however they are
 * split across trips.
 *
 * ⚠ The consequence, stated because it will be the first support question: the
 * day's FIRST leg pays RM0 and the pay lands on the second. That is the rule.
 */
describe("R5 A2 — one leg per booking, telescoping across the day", () => {
  const dayOf = (legCount: number) => {
    const paid: number[] = [];
    for (let i = 0; i < legCount; i++) {
      paid.push(interplant({ drops: legs(1), priorPointsToday: i }).incentiveThisTrip);
    }
    return paid;
  };

  it("the outbound leg earns nothing and the return leg earns the round trip", () => {
    expect(dayOf(2)).toEqual([0, 6]);
  });

  it("a lone leg with no return earns nothing at all", () => {
    expect(dayOf(1)).toEqual([0]);
  });

  it("three legs pay one round trip — the third waits for its pair", () => {
    expect(dayOf(3)).toEqual([0, 6, 0]);
  });

  it("every split of the same day sums to the same money", () => {
    const total = (paid: number[]) => paid.reduce((a, b) => a + b, 0);
    // Six legs, taken as six bookings…
    expect(total(dayOf(6))).toBe(3 * 6);
    // …as one booking with six stops…
    expect(interplant({ drops: legs(6), priorPointsToday: 0 }).incentiveThisTrip).toBe(3 * 6);
    // …and as two bookings of three.
    const first = interplant({ drops: legs(3), priorPointsToday: 0 });
    const second = interplant({ drops: legs(3), priorPointsToday: 3 });
    expect(first.incentiveThisTrip + second.incentiveThisTrip).toBe(3 * 6);
    // The pay lands unevenly (1 round trip then 2), which is correct: it is the
    // DAY that is halved, and the split between bookings is arbitrary.
    expect([first.incentiveThisTrip, second.incentiveThisTrip]).toEqual([6, 12]);
  });
});

/**
 * ⚠ NEGATIVE CONTROL. Customer/supplier work must be untouched — if this rule
 * ever leaked onto the customer pool it would halve every driver's real pay, and
 * under BL9 nothing could correct the approved trips afterwards.
 */
describe("R5 A2 — customer/supplier work is not halved", () => {
  const customer = (drops: ReturnType<typeof legs>, priorPointsToday = 0) =>
    calculateDeliveryIncentive({
      rateDateTime: WEEKDAY,
      drops,
      zonesDeliveredEarlierToday: [],
      priorPointsToday,
      publicHolidays: NO_HOLIDAYS,
      truck: { entitled_claim_weekday: 11, entitled_claim_offpeak: 13, daily_deduction_points: 2 },
    });

  it("the default is NO halving — an omitted flag must not change a single sen", () => {
    // PND 1888, day's first trip, one Ipoh drop (A2 = 6 pts), deduction 2:
    // the worked example pinned in incentiveEngine's own doc comment.
    const res = customer([{ zoneCode: "A2", zonePoints: 6 }]);
    expect(res.incentiveThisTrip).toBe(44);
    expect(res.roundTripShortfall).toBe(0);
    expect(res.deductionApplied).toBe(2);
  });

  it("an odd point total is paid in full, not floored to an even one", () => {
    const res = customer([{ zoneCode: "K1", zonePoints: 3 }]);
    expect(res.incentiveThisTrip).toBe((3 - 2) * 11);
  });
});

/**
 * The two day-level rules compose in a fixed order — deduction first (it is
 * subtracted from the day TOTAL), then the halving on what survives.
 *
 * Interplant carries deduction 0 today, so this pair can never fire together in
 * production. It is pinned anyway: `daily_deduction_points` is a per-truck DB
 * column an admin can edit, and the day the two do meet, "which applied first"
 * is worth a few ringgit per driver-day and nothing in the code would say.
 */
describe("R5 A2 — deduction and halving compose in one order", () => {
  const both = (drops: ReturnType<typeof legs>, deduction: number) =>
    calculateDeliveryIncentive({
      rateDateTime: WEEKDAY,
      drops,
      zonesDeliveredEarlierToday: [],
      priorPointsToday: 0,
      publicHolidays: NO_HOLIDAYS,
      truck: { entitled_claim_weekday: 6, entitled_claim_offpeak: 8, daily_deduction_points: deduction },
      roundTripHalving: true,
    });

  it("deducts from the day total FIRST, then halves the remainder", () => {
    // 7 points, deduction 2 → 5 survive → floor(5/2) = 2 round trips.
    const res = both(legs(7), 2);
    expect(res.incentiveThisTrip).toBe(2 * 6);
    // Halving the 7 first would give 3 − 2 = 1 round trip = RM6. It does not.
    expect(res.incentiveThisTrip).not.toBe(6);
  });

  it("reports the two withholdings separately, never as one number", () => {
    const res = both(legs(7), 2);
    // 7 scored → 2 taken by the deduction → 5 survive → 2 round trips PAID and
    // 3 points held back by the halving. The two withholdings must not be
    // summed into one field: interplant is the work with NO deduction, so a
    // `deduction_applied` of 5 on an interplant trip would be a printed
    // contradiction of the client's own rule.
    expect(res.deductionApplied).toBe(2);
    expect(res.roundTripShortfall).toBe(3);
    expect(res.pointsThisTrip - res.deductionApplied - res.roundTripShortfall).toBe(2 * 1);
  });
});

/**
 * ⚠ THE MIDNIGHT STRADDLE — A COMPLETED ROUND TRIP THAT PAYS NOTHING.
 *
 * This is a REAL, REACHABLE hole, pinned here rather than fixed. Halving the DAY
 * means a round trip split by the day boundary earns floor(1/2) on each side:
 * zero, twice, for work the client's rule was written to reward. There is no
 * carry-forward — an unpaired leg is lost when its day closes.
 *
 * Reachable two ways, neither exotic:
 *   1. the Return leg is BOOKED for the next morning. Send Monday evening,
 *      return Tuesday — ordinary, and nothing forbids it: each leg sits inside
 *      its own day's operating window, so no rule is broken.
 *   2. ONE booking whose two stops straddle midnight, which the engine already
 *      splits into two delivery-day groups of one point each.
 *
 * Batu Kawan plant runs are short, so (1) is the likely route in and it needs
 * only a requestor booking the return for the next morning.
 *
 * NOT FIXED, deliberately: every repair pairs legs across a day boundary, and
 * pairing is exactly what counting at day level removed ("18points for that
 * day"). Picking a pairing rule now would invent an answer to a question
 * Mr. Teh was never asked. Logged as an open item; these tests exist so the
 * next reader finds it here instead of in a driver's complaint.
 */
describe("⚠ R5 A2 — a round trip split by midnight pays NOTHING (known, unresolved)", () => {
  it("pays zero on BOTH sides of the boundary for one completed round trip", () => {
    // Monday's ledger and Tuesday's ledger each start empty: priorPointsToday is
    // bounded by the MYT day, so neither leg can ever see the other.
    const monday = interplant({ drops: legs(1), priorPointsToday: 0 });
    const tuesday = interplant({ drops: legs(1), priorPointsToday: 0 });

    expect(monday.incentiveThisTrip).toBe(0);
    expect(tuesday.incentiveThisTrip).toBe(0);
    // The same two legs delivered before midnight would have paid one round trip.
    expect(interplant({ drops: legs(1), priorPointsToday: 1 }).incentiveThisTrip).toBe(6);
  });

  it("scores both points and pays for neither — the work is recorded, the pay is not", () => {
    const monday = interplant({ drops: legs(1), priorPointsToday: 0 });
    expect(monday.pointsThisTrip).toBe(1); // the leg happened and is on the record
    expect(monday.roundTripShortfall).toBe(1); // and all of it was withheld
  });

  it("loses the odd leg permanently — nothing carries into the next day", () => {
    // Monday: 3 legs -> 1 round trip paid, 1 leg orphaned.
    expect(interplant({ drops: legs(3), priorPointsToday: 0 }).incentiveThisTrip).toBe(6);
    // Tuesday starts from zero. Monday's orphan does not join Tuesday's first leg.
    expect(interplant({ drops: legs(1), priorPointsToday: 0 }).incentiveThisTrip).toBe(0);
  });
});
