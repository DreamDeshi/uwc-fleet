import { describe, expect, it } from "vitest";
import { buildPayBreakdown } from "./payBreakdown";
import type { Trip, TripStop } from "../types";

// The engine's own worked example (incentiveEngine.ts): PLX 2406 weekday,
// day-first trip, one Ipoh drop — 6 pts, deduction 2, rate RM11 → the server
// pays (6−2)×11 = RM44. The breakdown must expose exactly the reconciling
// numbers (6 pts, −2, RM11/pt) and never invent an RM figure of its own.

function stop(over: Partial<TripStop>): TripStop {
  return {
    id: over.id ?? "s1",
    trip_id: "t1",
    sequence: over.sequence ?? 1,
    consignee_id: "c1",
    status: "delivered",
    arrived_at: null,
    delivered_at: null,
    pod_photo: null,
    do_uploaded: true,
    k2_photo: null,
    k2_form_ack: false,
    ...over,
  } as TripStop;
}

function trip(over: Partial<Trip>): Pick<Trip, "stops" | "deduction_applied" | "rate_used" | "round_trip_shortfall"> {
  return {
    stops: [],
    deduction_applied: null,
    rate_used: null,
    round_trip_shortfall: null,
    ...over,
  } as Pick<Trip, "stops" | "deduction_applied" | "rate_used" | "round_trip_shortfall">;
}

describe("buildPayBreakdown", () => {
  it("reconciles the engine's worked example: 6 pts − 2 deduction at RM11/pt", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ points_awarded: 6, was_repeat: false })],
        deduction_applied: 2,
        rate_used: "11.00",
      })
    )!;
    expect(b.totalPoints).toBe(6);
    expect(b.deduction).toBe(2);
    expect(b.payablePoints).toBe(4);
    expect(b.rate).toBe(11);
    // (payablePoints × rate) reconciles with the server's RM44 — but the lib
    // itself exposes no RM field: the server's figure is the only RM shown.
    expect("amount" in b).toBe(false);
  });

  it("orders rows by sequence and marks repeats", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [
          stop({ id: "s2", sequence: 2, points_awarded: 1, was_repeat: true }),
          stop({ id: "s1", sequence: 1, points_awarded: 3, was_repeat: false }),
        ],
        deduction_applied: 0,
        rate_used: 13,
      })
    )!;
    expect(b.rows.map((r) => r.stopId)).toEqual(["s1", "s2"]);
    expect(b.rows[1].wasRepeat).toBe(true);
    expect(b.totalPoints).toBe(4);
    expect(b.payablePoints).toBe(4); // zero deduction still yields a number
  });

  it("returns null when no stop carries evidence (unfinalized / legacy trips)", () => {
    expect(buildPayBreakdown(trip({ stops: [stop({})] }))).toBeNull();
    expect(buildPayBreakdown(trip({ stops: [] }))).toBeNull();
  });

  it("keeps deduction/rate null when unrecorded — display omits those rows", () => {
    const b = buildPayBreakdown(trip({ stops: [stop({ points_awarded: 2 })] }))!;
    expect(b.deduction).toBeNull();
    expect(b.payablePoints).toBeNull();
    expect(b.rate).toBeNull();
    expect(b.totalPoints).toBe(2);
  });
});

/**
 * R5 A2 (IM10) — THE LINE THAT EXPLAINS RM0.
 *
 * Interplant is paid per COMPLETED ROUND TRIP, so the day's first leg scores its
 * point and earns nothing; the pay lands on the return. It is the only place in
 * this system where a delivered, completed trip legitimately pays zero, and
 * until `round_trip_shortfall` was persisted the breakdown could only show a
 * delivered stop worth 1 point above a total of RM0 — which reads as the system
 * losing a driver's money, not as a rule.
 *
 * ⚠ The first case is the whole point of the column: WITHOUT the shortfall term,
 * `payablePoints` reads 1 while the server paid for 0, so the card would not
 * reconcile with the RM beside it.
 */
describe("buildPayBreakdown — points held for the return leg", () => {
  it("the day's FIRST interplant leg: 1 point scored, 1 held, nothing payable", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 1, was_repeat: false })],
        deduction_applied: 0,
        round_trip_shortfall: 1,
        rate_used: 6,
      })
    )!;
    expect(b.totalPoints).toBe(1); // the leg happened and is on the record
    expect(b.roundTripShortfall).toBe(1); // and all of it was withheld
    expect(b.payablePoints).toBe(0); // which is why the RM beside this is 0
  });

  it("the RETURN leg pays the whole round trip", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 1 })],
        deduction_applied: 0,
        round_trip_shortfall: 0,
        rate_used: 6,
      })
    )!;
    expect(b.roundTripShortfall).toBe(0);
    expect(b.payablePoints).toBe(1);
  });

  it("subtracts the deduction AND the held points, in that order", () => {
    // 7 scored → 2 to the deduction → 5 survive → floor(5/2) = 2 round trips
    // paid, 3 points held. The card must total 2, the figure the server paid.
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 7 })],
        deduction_applied: 2,
        round_trip_shortfall: 3,
        rate_used: 6,
      })
    )!;
    expect(b.payablePoints).toBe(2);
  });

  it("customer/supplier work is untouched — 0 withheld, and no line to render", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 6 })],
        deduction_applied: 2,
        round_trip_shortfall: 0,
        rate_used: 11,
      })
    )!;
    expect(b.roundTripShortfall).toBe(0);
    expect(b.payablePoints).toBe(4); // the RM44 anchor, unchanged
  });

  it("a trip finalized BEFORE the column reads null and changes nothing", () => {
    // Every trip in production today. `null` must not become a silent 0 that
    // implies "nothing was withheld" — it means "not recorded" — but it also
    // must not alter the arithmetic that has always been shown.
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 3 })],
        deduction_applied: 2,
        rate_used: 9,
      })
    )!;
    expect(b.roundTripShortfall).toBeNull();
    expect(b.payablePoints).toBe(1); // exactly what prod's TKT-20260810-001 shows
  });
});
