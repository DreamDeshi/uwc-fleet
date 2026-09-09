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
 * R5 A2 (IM10/IM11) — THE LINE THAT EXPLAINS THE GAP.
 *
 * Interplant is paid per COMPLETED ROUND TRIP. Before IM11 (9 Sep 2026) an
 * unpaired leg was floored to RM0 outright; the fix removed the floor, so a
 * lone leg now pays HALF rate instead, and `round_trip_shortfall` can be a
 * half-point (0.5, 2.5, …) — see incentiveEngine's `payable` comment. Without
 * this line, the driver's breakdown shows a delivered stop worth points and a
 * payout smaller than points × rate, which reads as the system losing money.
 *
 * ⚠ The first case is the whole point of the column: WITHOUT the shortfall
 * term, `payablePoints` reads 1 while the server paid for 0.5, so the card
 * would not reconcile with the RM beside it.
 */
describe("buildPayBreakdown — points discounted by round-trip pairing", () => {
  it("a lone interplant leg: 1 point scored, half held, half payable", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 1, was_repeat: false })],
        deduction_applied: 0,
        round_trip_shortfall: 0.5,
        rate_used: 6,
      })
    )!;
    expect(b.totalPoints).toBe(1); // the leg happened and is on the record
    expect(b.roundTripShortfall).toBe(0.5); // half withheld, not all of it (IM11)
    expect(b.payablePoints).toBe(0.5); // which is why the RM beside this is 3, not 0
  });

  it("arrives as a STRING over the wire (Decimal, IM11) and still computes correctly", () => {
    // round_trip_shortfall is Decimal(10,2) in the DB since IM11 — Prisma
    // serialises Decimal as a STRING over JSON ("0.50"), not a JS number. A
    // fixture using a real number here would never catch a broken Number()
    // conversion; this is the shape a genuine API response actually sends.
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 1, was_repeat: false })],
        deduction_applied: 0,
        round_trip_shortfall: "0.50" as unknown as number,
        rate_used: "6.00",
      })
    )!;
    expect(b.roundTripShortfall).toBe(0.5); // a real number, not the string "0.50"
    expect(typeof b.roundTripShortfall).toBe("number");
    expect(b.payablePoints).toBe(0.5); // arithmetic on it must not silently no-op
  });

  it("a same-day pair: each leg pays half, evenly — not zero-then-full", () => {
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 1 })],
        deduction_applied: 0,
        round_trip_shortfall: 0.5,
        rate_used: 6,
      })
    )!;
    expect(b.roundTripShortfall).toBe(0.5);
    expect(b.payablePoints).toBe(0.5);
  });

  it("subtracts the deduction AND the held points, in that order", () => {
    // 7 scored → 2 to the deduction → 5 survive → 5 / 2 = 2.5 round trips
    // paid, 2.5 points held. The card must total 2.5, the figure the server paid.
    const b = buildPayBreakdown(
      trip({
        stops: [stop({ id: "s1", sequence: 1, points_awarded: 7 })],
        deduction_applied: 2,
        round_trip_shortfall: 2.5,
        rate_used: 6,
      })
    )!;
    expect(b.payablePoints).toBe(2.5);
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
