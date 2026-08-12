import { describe, it, expect, vi } from "vitest";
import {
  weekdayEquivalent,
  resolveLastTripOt,
  otDemotionReason,
  persistedPaidPoints,
} from "../src/services/lastTripOt";

/**
 * R5 A4 (Mr. Teh, 11 Aug 2026) — "Option A…last drop point of the delivery only
 * count OT". Option A as put to him: only the LAST trip of the day can earn the
 * after-6pm rate. On PND 1888 that is RM11 vs RM13 a point.
 *
 * The decision runs at APPROVAL, because a trip finalizes the moment its last
 * stop is delivered and trips are serial — trip 1 always finalizes before trip 2
 * exists, so at proposal time "is this the last trip" is unknowable. Approval is
 * the last moment before BL9 makes the number permanent.
 *
 * `resolveLastTripOt` takes a narrow two-model client, so these drive it with a
 * stub: every branch, deterministically, with no clock and no database.
 * tests-integration/lastTripOt.test.ts proves the route actually calls it.
 */

// PND 1888's pair. A 6-point Ipoh run, deduction 2 → 4 points paid.
const OFF_PEAK = 13;
const WEEKDAY = 11;

const DELIVERED = new Date("2026-08-10T11:00:00Z"); // 19:00 MYT — after the cutoff

interface StubTrip {
  driver_id: string | null;
  off_peak: boolean | null;
  rate_used: number | null;
  incentive_earned: number | null;
  entitled_claim_weekday: number | null;
  entitled_claim_offpeak: number | null;
  deduction_applied: number | null;
  truck: { entitled_claim_weekday: number; entitled_claim_offpeak: number } | null;
  stops: { delivered_at: Date | null; points_awarded: number | null }[];
}

const TRIP: StubTrip = {
  driver_id: "driver-1",
  off_peak: true,
  rate_used: OFF_PEAK,
  incentive_earned: 4 * OFF_PEAK, // RM52
  entitled_claim_weekday: WEEKDAY,
  entitled_claim_offpeak: OFF_PEAK,
  // The DEDUCTION CASE is the default fixture on purpose: the day first trip
  // is both the deduction carrier and the natural demotion candidate, so every
  // test below runs against a trip whose 6 scored points were paid as 4.
  deduction_applied: 2,
  truck: { entitled_claim_weekday: WEEKDAY, entitled_claim_offpeak: OFF_PEAK },
  stops: [{ delivered_at: DELIVERED, points_awarded: 6 }],
};

/** A two-model stand-in: one trip row, and whether a later stop exists. */
const client = (trip: Partial<StubTrip>, laterStop: boolean) =>
  ({
    trip: { findUnique: async () => ({ ...TRIP, ...trip }) },
    tripStop: { findFirst: async () => (laterStop ? { id: "later-stop" } : null) },
  }) as never;

describe("R5 A4 — an earlier trip loses the after-6pm rate", () => {
  it("re-prices it at the weekday rate, reading the STORED points", async () => {
    const d = await resolveLastTripOt(client({}, true), "trip-1");
    expect(d).not.toBeNull();
    // 4 points were PAID (already net of the deduction), re-priced RM13 → RM11.
    expect(d!.points).toBe(4);
    expect(d!.amount).toBe(44);
    expect(d!.source).toBe("stored"); // not divided back out of the money
    expect(d!.weekdayRate).toBe(WEEKDAY);
    expect(d!.offPeakRate).toBe(OFF_PEAK);
  });

  it("names the rule and BOTH rates, so the audit row explains itself", () => {
    const reason = otDemotionReason({ amount: 44, points: 4, weekdayRate: 11, offPeakRate: 13, source: "stored" });
    expect(reason).toContain("A4");
    expect(reason).toContain("RM11");
    expect(reason).toContain("RM13");
  });

  it("leaves the LAST trip of the day alone — nothing happened after it", async () => {
    expect(await resolveLastTripOt(client({}, false), "trip-1")).toBeNull();
  });

  it("leaves a weekday trip alone — there is no premium to remove", async () => {
    expect(await resolveLastTripOt(client({ off_peak: false }, true), "trip-1")).toBeNull();
  });

  /**
   * `off_peak` is NULL when a trip finalized as MORE THAN ONE delivery-day group
   * — the midnight straddler, whose groups can hold different tiers. There is no
   * single tier to demote, so the proposal stands rather than being re-priced
   * against a rate that was only true for half the drops.
   */
  it("leaves a midnight straddler alone rather than guessing its tier", async () => {
    expect(await resolveLastTripOt(client({ off_peak: null, rate_used: null }, true), "t")).toBeNull();
  });

  it("does nothing when the trip earned nothing", async () => {
    expect(await resolveLastTripOt(client({ incentive_earned: null }, true), "t")).toBeNull();
  });

  it("does nothing for a trip with no delivery confirm to position it by", async () => {
    expect(
      await resolveLastTripOt(client({ stops: [{ delivered_at: null, points_awarded: null }] }, true), "t")
    ).toBeNull();
  });

  it("falls back to the truck's rate for a pre-rate-lock trip with no snapshot", async () => {
    const d = await resolveLastTripOt(client({ entitled_claim_weekday: null }, true), "t");
    expect(d!.amount).toBe(44); // the truck's RM11, not a zero rate
  });
  /**
   * THE INTERPLANT CASE - the one place the stored points CANNOT be used.
   * R5 A2 withholds points for an incomplete round trip, and that shortfall has
   * nowhere to be stored (IM10), so the sum of points_awarded OVERSTATES what
   * was paid. The identity check catches that and the money quotient carries the
   * trip. When IM10's column exists this returns to "stored" like everything else.
   */
  it("uses the money quotient when the stored points OVERSTATE the halved pay", async () => {
    const d = await resolveLastTripOt(
      client(
        {
          rate_used: 8,
          entitled_claim_weekday: 6,
          entitled_claim_offpeak: 8,
          incentive_earned: 8, // two legs scored, ONE round trip paid
          deduction_applied: 0,
          stops: [
            { delivered_at: DELIVERED, points_awarded: 1 },
            { delivered_at: DELIVERED, points_awarded: 1 },
          ],
        },
        true
      ),
      "t"
    );
    // Stored says 2 points; 2 x RM8 = RM16 != the RM8 proposed, so it is
    // rejected rather than used, and 1 point at RM6 is approved.
    expect(d!.points).toBe(1);
    expect(d!.source).toBe("money");
    expect(d!.amount).toBe(6);
  });

  it("leaves the trip alone, LOUDLY, when neither reading matches the money", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = await resolveLastTripOt(
      client({ incentive_earned: 50, deduction_applied: 0 }, true), // 50/13 is not whole
      "trip-x"
    );
    expect(d).toBeNull();
    // The failure mode this rule must never have is a silent no-op.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("trip-x"));
    warn.mockRestore();
  });
});

/**
 * The stored reading on its own - IM8's lesson applied. `points_awarded` is
 * persisted per stop and `deduction_applied` per trip, so the paid points are a
 * stored FACT rather than something recovered from ringgit.
 */
describe("R5 A4 - reading the persisted points", () => {
  it("sums the scored points and subtracts the day's deduction", () => {
    expect(
      persistedPaidPoints({
        stops: [
          { points_awarded: 6, delivered_at: DELIVERED },
          { points_awarded: 3, delivered_at: DELIVERED },
        ],
        deduction_applied: 2,
      })
    ).toBe(7);
  });

  it("ignores a stop that was never reached and therefore never scored", () => {
    expect(
      persistedPaidPoints({
        stops: [
          { points_awarded: 6, delivered_at: DELIVERED },
          { points_awarded: null, delivered_at: null },
        ],
        deduction_applied: 2,
      })
    ).toBe(4);
  });

  it("refuses when a DELIVERED stop has no points row - the sum would under-read", () => {
    expect(
      persistedPaidPoints({
        stops: [
          { points_awarded: 6, delivered_at: DELIVERED },
          { points_awarded: null, delivered_at: DELIVERED },
        ],
        deduction_applied: 0,
      })
    ).toBeNull();
  });

  it("treats a missing deduction column as zero, not as unknown", () => {
    expect(
      persistedPaidPoints({
        stops: [{ points_awarded: 4, delivered_at: DELIVERED }],
        deduction_applied: null,
      })
    ).toBe(4);
  });

  /**
   * ⚠ THE INTERPLANT CASE — the one this reading could not express until
   * `Trip.round_trip_shortfall` was persisted (IM10, 12 Aug 2026).
   *
   * R5 A2 withholds points that the STOPS still record as scored. Without the
   * shortfall term the sum overstates what was paid, the identity check
   * downstream rejects it, and every interplant trip fell through to the money
   * quotient. These cases are what make the stored path cover interplant too.
   */
  it("subtracts the points HELD BACK by the round-trip halving", () => {
    // A day's first interplant leg: 1 point scored, 1 withheld, 0 paid for.
    expect(
      persistedPaidPoints({
        stops: [{ points_awarded: 1, delivered_at: DELIVERED }],
        deduction_applied: 0,
        round_trip_shortfall: 1,
      })
    ).toBe(0);
    // Without the term this reads 1 — the overstatement that forced the fallback.
    expect(
      persistedPaidPoints({
        stops: [{ points_awarded: 1, delivered_at: DELIVERED }],
        deduction_applied: 0,
      })
    ).toBe(1);
  });

  it("applies the deduction AND the shortfall together", () => {
    // 7 scored, 2 to the deduction, 3 held by the halving → paid for 2.
    expect(
      persistedPaidPoints({
        stops: [{ points_awarded: 7, delivered_at: DELIVERED }],
        deduction_applied: 2,
        round_trip_shortfall: 3,
      })
    ).toBe(2);
  });

  it("treats a missing shortfall column as zero — every trip finalized before it", () => {
    expect(
      persistedPaidPoints({
        stops: [{ points_awarded: 3, delivered_at: DELIVERED }],
        deduction_applied: 2,
        round_trip_shortfall: null,
      })
    ).toBe(1);
  });
});

/**
 * The end the column was added for: an interplant trip's OT demotion is now
 * priced from STORED evidence rather than from dividing money by the rate.
 */
describe("R5 A4 x A2 - an interplant trip prices from stored points", () => {
  const INTERPLANT_OFFPEAK = 8;
  const INTERPLANT_WEEKDAY = 6;

  it("uses the STORED source on a leg that was paid, not the money quotient", () => {
    // One leg of a pair: 1 point scored, 0 withheld, so it was paid for 1 point
    // at the off-peak interplant rate.
    const priced = weekdayEquivalent({
      proposed: 1 * INTERPLANT_OFFPEAK,
      rateUsed: INTERPLANT_OFFPEAK,
      weekdayRate: INTERPLANT_WEEKDAY,
      storedPoints: persistedPaidPoints({
        stops: [{ points_awarded: 1, delivered_at: DELIVERED }],
        deduction_applied: 0,
        round_trip_shortfall: 0,
      }),
    });
    expect(priced).toEqual({ amount: INTERPLANT_WEEKDAY, points: 1, source: "stored" });
  });

  it("a MULTI-LEG interplant trip agrees on the stored reading too", () => {
    // 3 legs in one booking, prior 0: floor(3/2) = 1 round trip paid, 1 point
    // withheld... and the stops still add up to 3. Before the column, stored
    // said 3 while the money said 1, so `source` came back "money".
    const priced = weekdayEquivalent({
      proposed: 1 * INTERPLANT_OFFPEAK,
      rateUsed: INTERPLANT_OFFPEAK,
      weekdayRate: INTERPLANT_WEEKDAY,
      storedPoints: persistedPaidPoints({
        stops: [
          { points_awarded: 1, delivered_at: DELIVERED },
          { points_awarded: 1, delivered_at: DELIVERED },
          { points_awarded: 1, delivered_at: DELIVERED },
        ],
        deduction_applied: 0,
        round_trip_shortfall: 2,
      }),
    });
    expect(priced?.source).toBe("stored");
    expect(priced?.points).toBe(1);
    expect(priced?.amount).toBe(INTERPLANT_WEEKDAY);
  });
});


/**
 * ⚠ THE RECOVERY MUST BE EXACT OR NOT HAPPEN. The engine's last step is
 * `points × rate`, so dividing a proposal by the rate it used recovers the
 * points it was paid for. Where that division does not come back whole, the
 * proposal was not a plain points×rate product and re-pricing it would be an
 * inference. Money is not adjusted on an inference.
 */
describe("R5 A4 — weekdayEquivalent refuses anything it cannot recover exactly", () => {
  it("recovers whole points and re-prices them", () => {
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 13, weekdayRate: 11, storedPoints: null })).toEqual({
      amount: 44,
      points: 4,
      source: "money",
    });
  });

  it("survives a proposal rounded to cents", () => {
    // 3 points at RM12.33 = RM36.99, stored rounded; must still recover 3.
    expect(weekdayEquivalent({ proposed: 36.99, rateUsed: 12.33, weekdayRate: 11, storedPoints: null })?.points).toBe(3);
  });

  it("refuses a proposal that is not a whole number of points", () => {
    expect(weekdayEquivalent({ proposed: 50, rateUsed: 13, weekdayRate: 11, storedPoints: null })).toBeNull();
  });

  it("refuses a zero or missing rate rather than dividing by it", () => {
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 0, weekdayRate: 11, storedPoints: null })).toBeNull();
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 13, weekdayRate: 0, storedPoints: null })).toBeNull();
  });

  it("keeps a zero proposal at zero", () => {
    // An interplant outbound leg (R5 A2) proposes RM0. Re-pricing it is a no-op,
    // and must not become a divide-by-something surprise.
    expect(weekdayEquivalent({ proposed: 0, rateUsed: 8, weekdayRate: 6, storedPoints: 0 })).toEqual({
      amount: 0,
      points: 0,
      source: "stored",
    });
  });
});

/**
 * ⚠ NEGATIVE GUARD. This rule may only ever REMOVE a premium. If the arithmetic
 * ever came out higher than the proposal, something is wrong with the recovery
 * and the safe move is to leave the money alone — an approval that RAISES pay
 * on a rule nobody asked for is the one direction BL9 cannot undo.
 */
describe("R5 A4 — never raises a proposal", () => {
  it("stands down when the 'weekday' rate is the higher one", async () => {
    const d = await resolveLastTripOt(
      client({ entitled_claim_weekday: 20, truck: { entitled_claim_weekday: 20, entitled_claim_offpeak: 13 } }, true),
      "t"
    );
    expect(d).toBeNull();
  });
});
