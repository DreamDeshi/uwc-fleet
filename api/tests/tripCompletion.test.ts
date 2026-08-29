import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  approveTripIncentiveOnce,
  assertIncentiveApprovable,
  assertK2ApprovalConfirmed,
  assertStopArrivable,
  assertStopDeliverable,
  assertStopTapUndoable,
  collectFinalizeBreakdown,
  firstDeliveredAt,
  firstEarningInstant,
  payAttributionInstant,
  payableIncentive,
  proposeTripIncentiveOnce,
  revertFinalizeForUndo,
  STOP_TAP_UNDO_WINDOW_MS,
  type FinalizeBreakdown,
  type TripApproveClient,
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

describe("assertStopArrivable", () => {
  it("allows arriving a pending stop on an in_progress trip (happy path)", () => {
    expect(() =>
      assertStopArrivable({ status: "in_progress" }, { status: "pending" })
    ).not.toThrow();
  });

  it("rejects arriving on a not-started (assigned) trip → TRIP_NOT_STARTED", () => {
    expectApiError(
      () => assertStopArrivable({ status: "assigned" }, { status: "pending" }),
      "TRIP_NOT_STARTED",
      400
    );
  });

  it("rejects re-arriving an already-arrived stop mid-trip → INVALID_STATUS", () => {
    expectApiError(
      () => assertStopArrivable({ status: "in_progress" }, { status: "arrived" }),
      "INVALID_STATUS",
      400
    );
  });

  it("ORDERING (outbox-critical): non-pending stop on a NO-LONGER-active trip → INVALID_STATUS, not TRIP_NOT_STARTED", () => {
    // Both guards would fire here (delivered stop + completed trip); the
    // stop-status check must win so an offline-outbox replay of a completed
    // step reads as "already done → proceed" instead of a hard failure.
    expectApiError(
      () => assertStopArrivable({ status: "completed" }, { status: "delivered" }),
      "INVALID_STATUS",
      400
    );
  });
});

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

describe("assertStopTapUndoable (short-window mis-tap undo)", () => {
  const now = new Date("2026-08-28T10:00:00Z");
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

  it("allows undoing a fresh 'arrived' tap on an in_progress trip", () => {
    expect(() =>
      assertStopTapUndoable(
        { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
        { status: "arrived", arrived_at: secondsAgo(30), delivered_at: null },
        now
      )
    ).not.toThrow();
  });

  it("allows undoing a fresh 'delivered' tap that did NOT finalize the trip (still in_progress)", () => {
    expect(() =>
      assertStopTapUndoable(
        { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
        { status: "delivered", arrived_at: secondsAgo(90), delivered_at: secondsAgo(30) },
        now
      )
    ).not.toThrow();
  });

  it("allows undoing a fresh 'delivered' tap that DID finalize the trip, while unapproved", () => {
    expect(() =>
      assertStopTapUndoable(
        { status: "pending_approval", open_exception_id: null, incentive_approved_at: null },
        { status: "delivered", arrived_at: secondsAgo(90), delivered_at: secondsAgo(30) },
        now
      )
    ).not.toThrow();
  });

  it("rejects any undo while an exception is open → EXCEPTION_OPEN", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "in_progress", open_exception_id: "exc1", incentive_approved_at: null },
          { status: "arrived", arrived_at: secondsAgo(10), delivered_at: null },
          now
        ),
      "EXCEPTION_OPEN",
      409
    );
  });

  it("rejects a pending stop → NOTHING_TO_UNDO", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
          { status: "pending", arrived_at: null, delivered_at: null },
          now
        ),
      "NOTHING_TO_UNDO",
      400
    );
  });

  it("rejects undoing 'arrived' once the trip is no longer in_progress → TRIP_NOT_ACTIVE", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "assigned", open_exception_id: null, incentive_approved_at: null },
          { status: "arrived", arrived_at: secondsAgo(10), delivered_at: null },
          now
        ),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects undoing 'delivered' on a trip that is neither in_progress nor pending_approval → TRIP_NOT_ACTIVE", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "completed", open_exception_id: null, incentive_approved_at: new Date() },
          { status: "delivered", arrived_at: secondsAgo(90), delivered_at: secondsAgo(10) },
          now
        ),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects undoing 'delivered' once the incentive is approved, even if still pending_approval → INCENTIVE_ALREADY_APPROVED", () => {
    // Defence in depth: approval normally flips status to completed too, but
    // this must refuse on the money fact (incentive_approved_at) alone, not
    // rely on the status transition happening first.
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "pending_approval", open_exception_id: null, incentive_approved_at: new Date() },
          { status: "delivered", arrived_at: secondsAgo(90), delivered_at: secondsAgo(10) },
          now
        ),
      "INCENTIVE_ALREADY_APPROVED",
      409
    );
  });

  it("rejects an 'arrived' undo past the window → UNDO_WINDOW_EXPIRED", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
          { status: "arrived", arrived_at: new Date(now.getTime() - STOP_TAP_UNDO_WINDOW_MS - 1), delivered_at: null },
          now
        ),
      "UNDO_WINDOW_EXPIRED",
      409
    );
  });

  it("rejects a 'delivered' undo past the window → UNDO_WINDOW_EXPIRED, even though nothing else has consumed it", () => {
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
          {
            status: "delivered",
            arrived_at: new Date(now.getTime() - STOP_TAP_UNDO_WINDOW_MS - 60_000),
            delivered_at: new Date(now.getTime() - STOP_TAP_UNDO_WINDOW_MS - 1),
          },
          now
        ),
      "UNDO_WINDOW_EXPIRED",
      409
    );
  });

  it("allows right at the boundary (exactly the window) and rejects one ms past it", () => {
    expect(() =>
      assertStopTapUndoable(
        { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
        { status: "arrived", arrived_at: new Date(now.getTime() - STOP_TAP_UNDO_WINDOW_MS), delivered_at: null },
        now
      )
    ).not.toThrow();
    expectApiError(
      () =>
        assertStopTapUndoable(
          { status: "in_progress", open_exception_id: null, incentive_approved_at: null },
          { status: "arrived", arrived_at: new Date(now.getTime() - STOP_TAP_UNDO_WINDOW_MS - 1), delivered_at: null },
          now
        ),
      "UNDO_WINDOW_EXPIRED",
      409
    );
  });
});

describe("revertFinalizeForUndo (unwinds proposeTripIncentiveOnce for a delivered-tap undo)", () => {
  function fakeFinalizedTrip() {
    const row: Record<string, unknown> = {
      status: "pending_approval",
      incentive_earned: 44,
      rate_used: 11,
      off_peak: false,
      deduction_applied: 2,
      round_trip_shortfall: 0,
      incentive_approved_at: null,
    };
    const stopRows: Record<string, Record<string, unknown>> = {
      s1: { points_awarded: 6, was_repeat: false, zone_code: "A2" },
      s2: { points_awarded: 3, was_repeat: true, zone_code: "A2" },
    };
    const client: TripFinalizeClient = {
      trip: {
        async updateMany({ where, data }) {
          if (
            row.status !== where.status ||
            (where.incentive_approved_at === null && row.incentive_approved_at !== null)
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      tripStop: {
        async updateMany({ where, data }) {
          if ("id" in where) {
            stopRows[where.id] = { ...(stopRows[where.id] ?? {}), ...data };
            return { count: 1 };
          }
          for (const key of Object.keys(stopRows)) {
            stopRows[key] = { ...stopRows[key], ...data };
          }
          return { count: Object.keys(stopRows).length };
        },
      },
    };
    return { row, stopRows, client };
  }

  it("clears the trip's incentive/evidence fields and reopens it to in_progress", async () => {
    const { row, client } = fakeFinalizedTrip();
    expect(await revertFinalizeForUndo(client, "t1")).toBe(true);
    expect(row).toEqual({
      status: "in_progress",
      incentive_earned: null,
      rate_used: null,
      off_peak: null,
      deduction_applied: null,
      round_trip_shortfall: null,
      incentive_approved_at: null,
    });
  });

  it("clears the finalize snapshot on EVERY stop of the trip, not just the one being undone", async () => {
    const { stopRows, client } = fakeFinalizedTrip();
    await revertFinalizeForUndo(client, "t1");
    expect(stopRows["s1"]).toEqual({ points_awarded: null, was_repeat: null, zone_code: null });
    expect(stopRows["s2"]).toEqual({ points_awarded: null, was_repeat: null, zone_code: null });
  });

  it("refuses (CAS loses) once the incentive has been approved, and touches nothing", async () => {
    const { row, stopRows, client } = fakeFinalizedTrip();
    row.incentive_approved_at = new Date();
    expect(await revertFinalizeForUndo(client, "t1")).toBe(false);
    expect(row.status).toBe("pending_approval");
    expect(row.incentive_earned).toBe(44);
    expect(stopRows["s1"]).toEqual({ points_awarded: 6, was_repeat: false, zone_code: "A2" });
  });

  it("refuses (CAS loses) when the trip is no longer pending_approval", async () => {
    const { row, client } = fakeFinalizedTrip();
    row.status = "completed";
    expect(await revertFinalizeForUndo(client, "t1")).toBe(false);
    expect(row.status).toBe("completed");
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
        roundTripShortfall: 0,
      },
    },
  ]);
}

describe("proposeTripIncentiveOnce (POD-approval gate: write-once propose)", () => {
  // In-memory model of the status-guarded conditional update: the trip row
  // only matches while it is in_progress with no incentive written yet. The
  // winner flips it to pending_approval (NOT completed) and records evidence.
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
          if ("id" in where) {
            stopRows[where.id] = { ...(stopRows[where.id] ?? {}), ...data };
            return { count: 1 };
          }
          // trip_id-scoped clear (revertFinalizeForUndo): apply to every row
          // this fake already knows about, same as a real WHERE trip_id=… would.
          for (const key of Object.keys(stopRows)) {
            stopRows[key] = { ...stopRows[key], ...data };
          }
          return { count: Object.keys(stopRows).length };
        },
      },
    };
    return { row, stopRows, client };
  }

  it("proposes an in_progress trip exactly once → pending_approval, pay frozen but unpaid, evidence atomic", async () => {
    const { row, stopRows, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    expect(await proposeTripIncentiveOnce(client, "t1", 44, anchorBreakdown())).toBe(true);
    expect(row).toEqual({
      status: "pending_approval", // NOT completed — money is held until approval
      incentive_earned: 44, // the PROPOSAL is frozen here
      rate_used: 11,
      off_peak: false,
      deduction_applied: 2,
      // Recorded as 0, not absent: customer work withholds nothing, and a
      // reader must be able to tell that from "finalized before the column".
      round_trip_shortfall: 0,
    });
    // No incentive_final yet — payroll counts only `completed` trips.
    expect(row.incentive_final).toBeUndefined();
    expect(stopRows["s1"]).toEqual({ points_awarded: 6, was_repeat: false, zone_code: "A2" });
  });

  /**
   * R5 A2 (IM10) — the withheld points must reach the Trip row, or the driver's
   * breakdown cannot explain a RM0 leg and A4 cannot read an interplant trip's
   * paid points from stored evidence.
   */
  it("carries the round-trip shortfall onto the trip, SUMMED across day groups", () => {
    // The midnight straddler: one booking, two delivery-day groups, each with a
    // lone interplant leg it could not pair. Same shape as the deduction — each
    // group withheld its own day's figure, so they add.
    const breakdown = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "P2" }],
        result: { dropPoints: [1], wasRepeat: [false], rateUsed: 6, isOffPeak: false, deductionApplied: 0, roundTripShortfall: 1 },
      },
      {
        stops: [{ id: "s2", zoneCode: "P2" }],
        result: { dropPoints: [1], wasRepeat: [false], rateUsed: 6, isOffPeak: false, deductionApplied: 0, roundTripShortfall: 1 },
      },
    ]);
    expect(breakdown.tripData.round_trip_shortfall).toBe(2);
    // Both legs still SCORED — the points are on the record, the pay is not.
    expect(breakdown.stopRows.map((r) => r.points_awarded)).toEqual([1, 1]);
  });

  it("records a ZERO shortfall on customer work — recorded, not absent", () => {
    // `null` means "finalized before the column"; 0 means "measured, nothing
    // withheld". Every customer/supplier trip must write the 0, so a future
    // reader can tell the two apart.
    const breakdown = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 11, isOffPeak: false, deductionApplied: 2, roundTripShortfall: 0 },
      },
    ]);
    expect(breakdown.tripData.round_trip_shortfall).toBe(0);
  });

  it("a second proposal loses and never overwrites the stored proposal OR evidence", async () => {
    const { row, stopRows, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await proposeTripIncentiveOnce(client, "t1", 44, anchorBreakdown());
    const rerun = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 13, isOffPeak: true, deductionApplied: 0, roundTripShortfall: 0 },
      },
    ]);
    expect(await proposeTripIncentiveOnce(client, "t1", 66, rerun)).toBe(false);
    expect(row.incentive_earned).toBe(44); // proposal unchanged
    expect(row.rate_used).toBe(11); // evidence unchanged
    expect(stopRows["s1"].points_awarded).toBe(6); // loser never touched stop rows
  });

  it("never proposes a trip that is not in_progress (already delivered/approved)", async () => {
    const { row, client } = fakeTrip({ status: "pending_approval", incentive_earned: 44 });
    expect(await proposeTripIncentiveOnce(client, "t1", 66, anchorBreakdown())).toBe(false);
    expect(row.incentive_earned).toBe(44);
  });
});

describe("assertIncentiveApprovable (approval guard)", () => {
  it("allows confirming the proposal as-is (no final amount)", () => {
    expect(() =>
      assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, undefined, undefined)
    ).not.toThrow();
  });

  it("allows an edit that carries a reason", () => {
    expect(() =>
      assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, 50, "extra pallet")
    ).not.toThrow();
  });

  it("allows a 'final amount' equal to the proposal with no reason (not really an edit)", () => {
    expect(() =>
      assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, 44, undefined)
    ).not.toThrow();
  });

  it("rejects approving a trip that is not pending_approval → 409", () => {
    expectApiError(
      () => assertIncentiveApprovable({ status: "in_progress", incentive_earned: null }, undefined, undefined),
      "TRIP_NOT_PENDING_APPROVAL",
      409
    );
    expectApiError(
      () => assertIncentiveApprovable({ status: "completed", incentive_earned: 44 }, undefined, undefined),
      "TRIP_NOT_PENDING_APPROVAL",
      409
    );
  });

  it("rejects a negative final amount → 400", () => {
    expectApiError(
      () => assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, -1, "x"),
      "INVALID_AMOUNT",
      400
    );
  });

  it("rejects an EDITED amount with no reason → 400 (money edits are audited)", () => {
    expectApiError(
      () => assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, 50, undefined),
      "REASON_REQUIRED",
      400
    );
    // Whitespace-only reason is not a reason.
    expectApiError(
      () => assertIncentiveApprovable({ status: "pending_approval", incentive_earned: 44 }, 50, "   "),
      "REASON_REQUIRED",
      400
    );
  });
});

describe("assertK2ApprovalConfirmed (server-side counterpart of the admin K2ApprovalGate dialog)", () => {
  it("passes through when nothing is blocking", () => {
    expect(() => assertK2ApprovalConfirmed([], undefined)).not.toThrow();
    expect(() => assertK2ApprovalConfirmed([], "some reason")).not.toThrow();
  });

  it("rejects a blocking stop with no override reason → 409, names the stop", () => {
    expectApiError(
      () => assertK2ApprovalConfirmed([{ sequence: 2 }], undefined),
      "K2_MISSING_CONFIRM_REQUIRED",
      409
    );
    // Whitespace-only is not a reason, same rule as the edited-amount reason.
    expectApiError(
      () => assertK2ApprovalConfirmed([{ sequence: 2 }], "   "),
      "K2_MISSING_CONFIRM_REQUIRED",
      409
    );
  });

  it("allows a blocking stop through once an override reason is given", () => {
    expect(() =>
      assertK2ApprovalConfirmed([{ sequence: 1 }, { sequence: 3 }], "legacy row, predates the 29 Jul zone fix")
    ).not.toThrow();
  });
});

describe("approveTripIncentiveOnce (write-once approve → completed + payable)", () => {
  function fakeTrip(initial: { status: string; incentive_earned: number }) {
    const row: Record<string, unknown> = { ...initial };
    const client: TripApproveClient = {
      trip: {
        async updateMany({ data }) {
          if (row.status !== "pending_approval") return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    };
    return { row, client };
  }

  const approvedAt = new Date("2026-07-16T09:00:00Z");

  it("approving without an edit pays the proposal exactly and clears the override reason", async () => {
    const { row, client } = fakeTrip({ status: "pending_approval", incentive_earned: 44 });
    const ok = await approveTripIncentiveOnce(client, "t1", {
      proposedAmount: 44,
      adminId: "admin1",
      approvedAt,
    });
    expect(ok).toBe(true);
    expect(row).toEqual({
      status: "completed",
      incentive_earned: 44, // proposal preserved
      incentive_final: 44, // payable == proposal
      incentive_override_reason: null, // not edited
      incentive_approved_at: approvedAt,
      incentive_approved_by: "admin1",
    });
  });

  it("approving with an edit stores the edited final + reason and preserves the proposal", async () => {
    const { row, client } = fakeTrip({ status: "pending_approval", incentive_earned: 44 });
    const ok = await approveTripIncentiveOnce(client, "t1", {
      proposedAmount: 44,
      finalAmount: 50,
      reason: "extra pallet on the DO",
      adminId: "admin1",
      approvedAt,
    });
    expect(ok).toBe(true);
    expect(row.incentive_earned).toBe(44); // proposal preserved for the audit trail
    expect(row.incentive_final).toBe(50); // payroll pays this
    expect(row.incentive_override_reason).toBe("extra pallet on the DO");
  });

  it("a final amount equal to the proposal is NOT an edit (reason nulled even if passed)", async () => {
    const { row, client } = fakeTrip({ status: "pending_approval", incentive_earned: 44 });
    await approveTripIncentiveOnce(client, "t1", {
      proposedAmount: 44,
      finalAmount: 44,
      reason: "should be ignored",
      adminId: "admin1",
      approvedAt,
    });
    expect(row.incentive_final).toBe(44);
    expect(row.incentive_override_reason).toBeNull();
  });

  it("a second approval loses — the amount is never double-set", async () => {
    const { row, client } = fakeTrip({ status: "pending_approval", incentive_earned: 44 });
    await approveTripIncentiveOnce(client, "t1", { proposedAmount: 44, adminId: "a1", approvedAt });
    const second = await approveTripIncentiveOnce(client, "t1", {
      proposedAmount: 44,
      finalAmount: 99,
      reason: "late edit",
      adminId: "a2",
      approvedAt,
    });
    expect(second).toBe(false);
    expect(row.incentive_final).toBe(44); // first approval stands
    expect(row.incentive_approved_by).toBe("a1");
  });
});

describe("payableIncentive (the ONE 'what did this trip pay' read)", () => {
  it("pays the admin-approved final when present", () => {
    expect(payableIncentive({ incentive_final: 50, incentive_earned: 44 })).toBe(50);
  });

  it("grandfathers a pre-gate trip: final null → pays the engine proposal", () => {
    expect(payableIncentive({ incentive_final: null, incentive_earned: 44 })).toBe(44);
    expect(payableIncentive({ incentive_earned: 44 })).toBe(44);
  });

  it("an approved-down-to-zero trip pays 0, not the proposal (0 is a real final)", () => {
    // Editing the final to 0 must win over the proposal — ?? only falls through
    // on null/undefined, so a legitimate zero payout is honoured.
    expect(payableIncentive({ incentive_final: 0, incentive_earned: 44 })).toBe(0);
  });

  it("pays 0 when nothing is recorded", () => {
    expect(payableIncentive({})).toBe(0);
    expect(payableIncentive({ incentive_final: null, incentive_earned: null })).toBe(0);
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
          roundTripShortfall: 0,
        },
      },
    ]);
    expect(b.stopRows).toEqual([
      { id: "s1", points_awarded: 6, was_repeat: false, zone_code: "A2" },
      { id: "s2", points_awarded: 3, was_repeat: false, zone_code: "K1" },
      { id: "s3", points_awarded: 1, was_repeat: true, zone_code: "A2" },
    ]);
    expect(b.tripData).toEqual({ rate_used: 11, off_peak: false, deduction_applied: 2, round_trip_shortfall: 0 });
  });

  it("midnight-straddler (two day groups): per-stop rows exact, trip-level tier NULL, deductions sum", () => {
    const b = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 13, isOffPeak: true, deductionApplied: 2, roundTripShortfall: 0 },
      },
      {
        stops: [{ id: "s2", zoneCode: "K1" }],
        result: { dropPoints: [3], wasRepeat: [false], rateUsed: 11, isOffPeak: false, deductionApplied: 2, roundTripShortfall: 0 },
      },
    ]);
    expect(b.stopRows.map((s) => s.points_awarded)).toEqual([6, 3]);
    // A single trip-level rate would be wrong for half the drops → NULL, while
    // each group's own-day deduction is well-defined and sums.
    expect(b.tripData).toEqual({ rate_used: null, off_peak: null, deduction_applied: 4, round_trip_shortfall: 0 });
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

describe("payAttributionInstant - the ONE month-bucket key for trips and money", () => {
  const pickup = new Date("2026-06-30T01:00:00Z");

  it("keys on the first delivery confirm - a 30 June pickup delivered 1 July is July money", () => {
    const delivered = new Date("2026-06-30T18:00:00Z"); // 1 Jul 02:00 MYT
    expect(
      payAttributionInstant({ pickup_datetime: pickup, stops: [{ delivered_at: delivered }] })
    ).toBe(delivered);
  });

  it("falls back to pickup when nothing earned", () => {
    expect(
      payAttributionInstant({ pickup_datetime: pickup, stops: [{ delivered_at: null }] })
    ).toBe(pickup);
  });
});

describe("firstEarningInstant - R3 Q11(a) widening of the month bucket", () => {
  // A stop the driver REACHED, an admin VERIFIED, and that closed with `resume`
  // is paid (services/undeliveredPay.ts) and attributes to its arrival. A trip
  // whose stops ALL ended that way has no delivery confirm at all.
  const arrived = new Date("2026-07-01T02:00:00Z"); // 1 Jul 10:00 MYT
  const delivered = new Date("2026-07-01T04:00:00Z");
  const settled = (arrived_at: Date | null) => ({
    status: "arrived",
    arrived_at,
    delivered_at: null,
    exceptions: [
      {
        current_state: "resolved",
        resolution: "resume",
        actions: [{ type: "verify" }],
      },
    ],
  });

  it("uses a settled stop's ARRIVAL when the trip has no delivery confirm", () => {
    expect(firstEarningInstant([settled(arrived)])).toBe(arrived);
  });

  it("keeps an all-failed trip in the month it was WORKED, not the month it was picked up", () => {
    // The concrete bug: picked up 30 June, the attempt (and its pay) on 1 July.
    // The delivered-only version returned null, fell back to pickup, and put
    // real July pay on the June payroll sheet.
    const pickupJune = new Date("2026-06-30T16:00:00Z"); // 1 Jul 00:00 MYT is next
    expect(
      payAttributionInstant({ pickup_datetime: pickupJune, stops: [settled(arrived)] })
    ).toBe(arrived);
  });

  it("within ONE stop a delivery confirm always wins over its own arrival", () => {
    expect(
      firstEarningInstant([{ ...settled(arrived), status: "delivered", delivered_at: delivered }])
    ).toBe(delivered);
  });

  it("ACROSS stops it is the EARLIEST earning instant - a settled arrival CAN win", () => {
    // Deliberate, and NOT "strictly additive": a trip that failed a stop at
    // 23:40 on 31 Jul and delivered another at 00:20 on 1 Aug now buckets into
    // July where it used to bucket into August. This function's contract is to
    // mirror what finalization scored against, and finalization's first
    // day-group anchors on exactly this instant — a month key that disagreed
    // with the ledger would put the payroll sheet and the pay in different
    // months. It moves a pay PERIOD, never an amount.
    expect(firstEarningInstant([settled(arrived), { delivered_at: delivered }])).toBe(arrived);
  });

  it("ignores a stop the driver never reached (Q11(b))", () => {
    expect(firstEarningInstant([settled(null)])).toBeNull();
  });

  it("a caller that selects ONLY delivered_at gets exactly the old behaviour", () => {
    // The widening fields are optional so an under-selected query degrades to
    // delivered-only rather than silently answering wrong.
    expect(firstEarningInstant([{ delivered_at: null }])).toBeNull();
    expect(firstEarningInstant([{ delivered_at: delivered }])).toBe(delivered);
  });

  it("does not pay on a bare resume or a retry", () => {
    const bareResume = {
      ...settled(arrived),
      exceptions: [{ current_state: "resolved", resolution: "resume", actions: [] }],
    };
    const retried = {
      ...settled(arrived),
      exceptions: [
        { current_state: "resolved", resolution: "retry", actions: [{ type: "verify" }] },
      ],
    };
    expect(firstEarningInstant([bareResume])).toBeNull();
    expect(firstEarningInstant([retried])).toBeNull();
  });
});
