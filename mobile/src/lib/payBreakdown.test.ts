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

function trip(over: Partial<Trip>): Pick<Trip, "stops" | "deduction_applied" | "rate_used"> {
  return {
    stops: [],
    deduction_applied: null,
    rate_used: null,
    ...over,
  } as Pick<Trip, "stops" | "deduction_applied" | "rate_used">;
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
