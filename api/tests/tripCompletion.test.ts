import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  assertStopDeliverable,
  collectFinalizeBreakdown,
  finalizeTripOnce,
  firstDeliveredAt,
  type FinalizeBreakdown,
  type TripFinalizeClient,
} from "../src/services/tripCompletion";

/**
 * Guards that close the re-finalization pay hole: a driver re-posting
 * action=delivered (with an explicit stop_id) on a COMPLETED trip must never
 * re-run finalization — that would overwrite incentive_earned at the live
 * rates and current day ledger (e.g. RM44 Ipoh trip re-scored → RM66).
 */

function expectApiError(fn: () => void, code: string, statusCode: number) {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    expect((err as ApiError).statusCode).toBe(statusCode);
  }
}

describe("assertStopDeliverable", () => {
  it("rejects delivery on a completed trip (re-finalization attempt)", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "completed" }, { status: "delivered" }),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects delivery on a trip that was never started (assigned)", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "assigned" }, { status: "pending" }),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects re-delivering an already-delivered stop mid-trip", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "in_progress" }, { status: "delivered" }),
      "STOP_ALREADY_DELIVERED",
      409
    );
  });

  it("allows delivering a pending or arrived stop on an in_progress trip", () => {
    expect(() =>
      assertStopDeliverable({ status: "in_progress" }, { status: "pending" })
    ).not.toThrow();
    expect(() =>
      assertStopDeliverable({ status: "in_progress" }, { status: "arrived" })
    ).not.toThrow();
  });
});

// The RM44 anchor case's breakdown: one Ipoh drop, full 6 points, weekday
// RM11, deduction 2 → (6−2)×11 = RM44.
function anchorBreakdown(): FinalizeBreakdown {
  return collectFinalizeBreakdown([
    {
      stops: [{ id: "s1", zoneCode: "A2" }],
      result: {
        dropPoints: [6],
        wasRepeat: [false],
        rateUsed: 11,
        isOffPeak: false,
        deductionApplied: 2,
      },
    },
  ]);
}

describe("finalizeTripOnce (write-once compare-and-set)", () => {
  // In-memory model of the status-guarded conditional update: the trip row
  // only matches while it is in_progress with no incentive written yet, and
  // stop rows record whatever breakdown the winner persisted.
  function fakeTrip(initial: { status: string; incentive_earned: number | null }) {
    const row: Record<string, unknown> = { ...initial };
    const stopRows: Record<string, Record<string, unknown>> = {};
    const client: TripFinalizeClient = {
      trip: {
        async updateMany({ data }) {
          if (row.status !== "in_progress" || row.incentive_earned !== null) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      tripStop: {
        async updateMany({ where, data }) {
          stopRows[where.id] = { ...(stopRows[where.id] ?? {}), ...data };
          return { count: 1 };
        },
      },
    };
    return { row, stopRows, client };
  }

  it("finalizes an in_progress trip exactly once, persisting pay + evidence atomically", async () => {
    const { row, stopRows, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    expect(await finalizeTripOnce(client, "t1", 44, anchorBreakdown())).toBe(true);
    expect(row).toEqual({
      status: "completed",
      incentive_earned: 44,
      rate_used: 11,
      off_peak: false,
      deduction_applied: 2,
    });
    expect(stopRows["s1"]).toEqual({ points_awarded: 6, was_repeat: false, zone_code: "A2" });
  });

  it("a second finalization loses and never overwrites the stored incentive OR evidence", async () => {
    const { row, stopRows, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await finalizeTripOnce(client, "t1", 44, anchorBreakdown());
    // Re-delivery scenario: rates/day-ledger have changed, recompute says 66.
    const rerun = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 13, isOffPeak: true, deductionApplied: 0 },
      },
    ]);
    expect(await finalizeTripOnce(client, "t1", 66, rerun)).toBe(false);
    expect(row.incentive_earned).toBe(44); // pay unchanged
    expect(row.rate_used).toBe(11); // evidence unchanged
    expect(stopRows["s1"].points_awarded).toBe(6); // loser never touched stop rows
  });

  it("never finalizes a trip that is not in_progress", async () => {
    const { row, client } = fakeTrip({ status: "completed", incentive_earned: 44 });
    expect(await finalizeTripOnce(client, "t1", 66, anchorBreakdown())).toBe(false);
    expect(row.incentive_earned).toBe(44);
  });

  it("holiday-calendar edits never touch stored pay: a re-finalization at the new tier loses", async () => {
    // Weekday Ipoh trip finalized at RM44 with an empty calendar; an admin then
    // adds that date as a holiday. Recomputing WOULD give (6−2)×13 = RM52, but
    // the decision ran exactly once at finalization — the CAS refuses a rerun
    // and the stored pay stays RM44 (readers only ever sum the stored value).
    const { row, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await finalizeTripOnce(client, "t1", 44, anchorBreakdown());
    expect(await finalizeTripOnce(client, "t1", 52, anchorBreakdown())).toBe(false);
    expect(row.status).toBe("completed");
    expect(row.incentive_earned).toBe(44);
  });
});

describe("collectFinalizeBreakdown (the engine's outputs → persisted evidence)", () => {
  it("keeps stops index-aligned with the engine's per-drop scores", () => {
    const b = collectFinalizeBreakdown([
      {
        stops: [
          { id: "s1", zoneCode: "A2" },
          { id: "s2", zoneCode: "K1" },
          { id: "s3", zoneCode: "A2" },
        ],
        result: {
          dropPoints: [6, 3, 1],
          wasRepeat: [false, false, true],
          rateUsed: 11,
          isOffPeak: false,
          deductionApplied: 2,
        },
      },
    ]);
    expect(b.stopRows).toEqual([
      { id: "s1", points_awarded: 6, was_repeat: false, zone_code: "A2" },
      { id: "s2", points_awarded: 3, was_repeat: false, zone_code: "K1" },
      { id: "s3", points_awarded: 1, was_repeat: true, zone_code: "A2" },
    ]);
    expect(b.tripData).toEqual({ rate_used: 11, off_peak: false, deduction_applied: 2 });
  });

  it("midnight-straddler (two day groups): per-stop rows exact, trip-level tier NULL, deductions sum", () => {
    const b = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 13, isOffPeak: true, deductionApplied: 2 },
      },
      {
        stops: [{ id: "s2", zoneCode: "K1" }],
        result: { dropPoints: [3], wasRepeat: [false], rateUsed: 11, isOffPeak: false, deductionApplied: 2 },
      },
    ]);
    expect(b.stopRows.map((s) => s.points_awarded)).toEqual([6, 3]);
    // A single trip-level rate would be wrong for half the drops → NULL, while
    // each group's own-day deduction is well-defined and sums.
    expect(b.tripData).toEqual({ rate_used: null, off_peak: null, deduction_applied: 4 });
  });
});

describe("firstDeliveredAt - the surfaced pay-deciding timestamp (finding 1.5)", () => {
  it("returns the earliest delivery confirm - the day-group anchor the rate tier keyed on", () => {
    const first = new Date("2026-07-04T10:05:00Z"); // 18:05 MYT - the boundary case
    const later = new Date("2026-07-04T11:40:00Z");
    expect(
      firstDeliveredAt([{ delivered_at: later }, { delivered_at: first }, { delivered_at: null }])
    ).toBe(first);
  });

  it("returns null when no stop has a delivered record", () => {
    expect(firstDeliveredAt([{ delivered_at: null }])).toBeNull();
    expect(firstDeliveredAt([])).toBeNull();
  });
});
