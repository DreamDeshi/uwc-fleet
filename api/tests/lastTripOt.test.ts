import { describe, it, expect } from "vitest";
import { weekdayEquivalent, resolveLastTripOt, otDemotionReason } from "../src/services/lastTripOt";

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
  truck: { entitled_claim_weekday: number; entitled_claim_offpeak: number } | null;
  stops: { delivered_at: Date | null }[];
}

const TRIP: StubTrip = {
  driver_id: "driver-1",
  off_peak: true,
  rate_used: OFF_PEAK,
  incentive_earned: 4 * OFF_PEAK, // RM52
  entitled_claim_weekday: WEEKDAY,
  entitled_claim_offpeak: OFF_PEAK,
  truck: { entitled_claim_weekday: WEEKDAY, entitled_claim_offpeak: OFF_PEAK },
  stops: [{ delivered_at: DELIVERED }],
};

/** A two-model stand-in: one trip row, and whether a later stop exists. */
const client = (trip: Partial<StubTrip>, laterStop: boolean) =>
  ({
    trip: { findUnique: async () => ({ ...TRIP, ...trip }) },
    tripStop: { findFirst: async () => (laterStop ? { id: "later-stop" } : null) },
  }) as never;

describe("R5 A4 — an earlier trip loses the after-6pm rate", () => {
  it("re-prices the day's earlier trip at the weekday rate", async () => {
    const d = await resolveLastTripOt(client({}, true), "trip-1");
    expect(d).not.toBeNull();
    // 4 points were PAID (already net of the deduction), re-priced RM13 → RM11.
    expect(d!.points).toBe(4);
    expect(d!.amount).toBe(44);
    expect(d!.weekdayRate).toBe(WEEKDAY);
    expect(d!.offPeakRate).toBe(OFF_PEAK);
  });

  it("names the rule and BOTH rates, so the audit row explains itself", () => {
    const reason = otDemotionReason({ amount: 44, points: 4, weekdayRate: 11, offPeakRate: 13 });
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
    expect(await resolveLastTripOt(client({ stops: [{ delivered_at: null }] }, true), "t")).toBeNull();
  });

  it("falls back to the truck's rate for a pre-rate-lock trip with no snapshot", async () => {
    const d = await resolveLastTripOt(client({ entitled_claim_weekday: null }, true), "t");
    expect(d!.amount).toBe(44); // the truck's RM11, not a zero rate
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
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 13, weekdayRate: 11 })).toEqual({
      amount: 44,
      points: 4,
    });
  });

  it("survives a proposal rounded to cents", () => {
    // 3 points at RM12.33 = RM36.99, stored rounded; must still recover 3.
    expect(weekdayEquivalent({ proposed: 36.99, rateUsed: 12.33, weekdayRate: 11 })?.points).toBe(3);
  });

  it("refuses a proposal that is not a whole number of points", () => {
    expect(weekdayEquivalent({ proposed: 50, rateUsed: 13, weekdayRate: 11 })).toBeNull();
  });

  it("refuses a zero or missing rate rather than dividing by it", () => {
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 0, weekdayRate: 11 })).toBeNull();
    expect(weekdayEquivalent({ proposed: 52, rateUsed: 13, weekdayRate: 0 })).toBeNull();
  });

  it("keeps a zero proposal at zero", () => {
    // An interplant outbound leg (R5 A2) proposes RM0. Re-pricing it is a no-op,
    // and must not become a divide-by-something surprise.
    expect(weekdayEquivalent({ proposed: 0, rateUsed: 8, weekdayRate: 6 })).toEqual({
      amount: 0,
      points: 0,
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
