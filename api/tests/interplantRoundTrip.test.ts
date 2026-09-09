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
 * So: the DAY's interplant points ÷ 2. Counting at day level is what removes
 * the Delivery-to-Return pairing problem entirely.
 *
 * ⚠ IM11 FIX (owner decision, 9 Sep 2026) — NO LONGER FLOORED. Teh's literal
 * arithmetic floors an odd leftover to nothing (17 → 8), which is exactly what
 * let a round trip split by the MYT day boundary pay ZERO on both sides — a
 * genuinely completed round trip earning nothing, with no way to recover it.
 * The fix removes the floor (points / 2, not floor(points / 2)): a KNOWN,
 * ACCEPTED deviation from his exact numbers (17 → 8.5, not 8), made because a
 * lone leg's worst case is now half rate, never zero. See the `payable`
 * comment in incentiveEngine.ts for the full reasoning, including why this
 * also makes the midnight straddle stop being a special case at all — the
 * formula is now linear, so every leg's marginal pay is exactly half its own
 * points, independent of pairing, order, or which day it lands in.
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

describe("R5 A2 — his own two numbers (one now deviates, deliberately — see IM11)", () => {
  it("18 points in a day pays 9 — even split, unaffected by the IM11 fix", () => {
    const res = interplant({ drops: legs(18), priorPointsToday: 0 });
    expect(res.pointsThisTrip).toBe(18);
    expect(res.incentiveThisTrip).toBe(9 * 6);
    expect(res.roundTripShortfall).toBe(9);
  });

  it("17 points in a day pays 8.5, not 8 — the floor was removed (IM11)", () => {
    const res = interplant({ drops: legs(17), priorPointsToday: 0 });
    expect(res.pointsThisTrip).toBe(17);
    // Was 8 × 6 = RM48 (floored). Now 8.5 × 6 = RM51 — the odd leg earns half,
    // not nothing. Teh's own example said 8; this is the accepted deviation.
    expect(res.incentiveThisTrip).toBe(8.5 * 6);
    expect(res.incentiveThisTrip).not.toBe(8 * 6);
    expect(res.roundTripShortfall).toBe(8.5);
  });
});

/**
 * THE HALVING IS NOW A PURE LINEAR RULE — no telescoping state needed. Each
 * leg's marginal pay is exactly half of its own scored points, full stop,
 * regardless of what came before it that day. (Before the IM11 fix, the floor
 * made this order-dependent: the day's first leg paid RM0 and the second
 * picked up the full pair. That asymmetry is gone.)
 */
describe("R5 A2 — one leg per booking: every leg pays exactly half, independent of order", () => {
  const dayOf = (legCount: number) => {
    const paid: number[] = [];
    for (let i = 0; i < legCount; i++) {
      paid.push(interplant({ drops: legs(1), priorPointsToday: i }).incentiveThisTrip);
    }
    return paid;
  };

  it("two legs: BOTH pay half the round trip, not zero-then-full", () => {
    expect(dayOf(2)).toEqual([3, 3]);
  });

  it("a lone leg with no return earns HALF, not nothing — the IM11 fix itself", () => {
    expect(dayOf(1)).toEqual([3]);
  });

  it("three legs: every leg pays the same half-rate, none of them 'waits'", () => {
    expect(dayOf(3)).toEqual([3, 3, 3]);
  });

  it("every split of the same day sums to the same money, and now splits evenly too", () => {
    const total = (paid: number[]) => paid.reduce((a, b) => a + b, 0);
    // Six legs, taken as six bookings…
    expect(total(dayOf(6))).toBe(3 * 6);
    // …as one booking with six stops…
    expect(interplant({ drops: legs(6), priorPointsToday: 0 }).incentiveThisTrip).toBe(3 * 6);
    // …and as two bookings of three.
    const first = interplant({ drops: legs(3), priorPointsToday: 0 });
    const second = interplant({ drops: legs(3), priorPointsToday: 3 });
    expect(first.incentiveThisTrip + second.incentiveThisTrip).toBe(3 * 6);
    // Unlike the old floored rule (which paid [6, 12] — uneven, order-dependent),
    // the linear formula pays each booking exactly half its own points: even,
    // and independent of how the day is split into bookings.
    expect([first.incentiveThisTrip, second.incentiveThisTrip]).toEqual([9, 9]);
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

  it("an odd point total is paid in full, not halved to a fractional one", () => {
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
    // 7 points, deduction 2 → 5 survive → 5 / 2 = 2.5 round trips (no floor).
    const res = both(legs(7), 2);
    expect(res.incentiveThisTrip).toBe(2.5 * 6);
    // Halving the 7 first would give 3.5 − 2 = 1.5 round trips = RM9. It does not.
    expect(res.incentiveThisTrip).not.toBe(1.5 * 6);
  });

  it("reports the two withholdings separately, never as one number", () => {
    const res = both(legs(7), 2);
    // 7 scored → 2 taken by the deduction → 5 survive → 2.5 round trips PAID
    // and 2.5 points held back by the halving. The two withholdings must not be
    // summed into one field: interplant is the work with NO deduction, so a
    // `deduction_applied` of 5 on an interplant trip would be a printed
    // contradiction of the client's own rule.
    expect(res.deductionApplied).toBe(2);
    expect(res.roundTripShortfall).toBe(2.5);
    expect(res.pointsThisTrip - res.deductionApplied - res.roundTripShortfall).toBe(2.5);
  });
});

/**
 * ⚠ THE MIDNIGHT STRADDLE — WAS "A COMPLETED ROUND TRIP THAT PAYS NOTHING",
 * NOW FIXED (IM11, 9 Sep 2026). This used to be a known, deliberately
 * unresolved hole (git blame this file for the original version). Removing
 * the floor fixes it as a side effect, without adding any pairing logic: the
 * formula no longer cares which day either leg landed in.
 *
 * Reachable two ways, neither exotic:
 *   1. the Return leg is BOOKED for the next morning. Send Monday evening,
 *      return Tuesday — ordinary, and nothing forbids it: each leg sits inside
 *      its own day's operating window, so no rule is broken.
 *   2. ONE booking whose two stops straddle midnight, which the engine already
 *      splits into two delivery-day groups of one point each.
 */
describe("R5 A2 — a round trip split by midnight now pays half on both sides (IM11 fixed)", () => {
  it("pays half on BOTH sides of the boundary, not zero", () => {
    // Monday's ledger and Tuesday's ledger each start empty: priorPointsToday is
    // bounded by the MYT day, so neither leg can ever see the other — and it no
    // longer needs to, since each leg's pay depends only on its own points.
    const monday = interplant({ drops: legs(1), priorPointsToday: 0 });
    const tuesday = interplant({ drops: legs(1), priorPointsToday: 0 });

    expect(monday.incentiveThisTrip).toBe(3);
    expect(tuesday.incentiveThisTrip).toBe(3);
    // A same-day pair pays the SAME per leg — 3 + 3 = 6, one round trip's
    // worth, split evenly instead of 0-then-6.
    expect(interplant({ drops: legs(1), priorPointsToday: 1 }).incentiveThisTrip).toBe(3);
  });

  it("scores the point and pays half for it — not fully withheld any more", () => {
    const monday = interplant({ drops: legs(1), priorPointsToday: 0 });
    expect(monday.pointsThisTrip).toBe(1); // the leg happened and is on the record
    expect(monday.roundTripShortfall).toBe(0.5); // half withheld, not all of it
  });

  it("nothing is lost across the day boundary any more — each side pays independently", () => {
    // Monday: 3 legs -> each pays half, same as any other day (no more "the
    // third waits for its pair" — there is no pairing state left to wait on).
    expect(interplant({ drops: legs(3), priorPointsToday: 0 }).incentiveThisTrip).toBe(1.5 * 6);
    // Tuesday starts from zero and pays its own lone leg half, same as Monday's did.
    expect(interplant({ drops: legs(1), priorPointsToday: 0 }).incentiveThisTrip).toBe(3);
  });
});
