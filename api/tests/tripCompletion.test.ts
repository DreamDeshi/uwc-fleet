import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  approveTripIncentiveOnce,
  assertIncentiveApprovable,
  assertStopArrivable,
  assertStopDeliverable,
  collectFinalizeBreakdown,
  firstDeliveredAt,
  payAttributionInstant,
  payableIncentive,
  proposeTripIncentiveOnce,
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
          stopRows[where.id] = { ...(stopRows[where.id] ?? {}), ...data };
          return { count: 1 };
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
    });
    // No incentive_final yet — payroll counts only `completed` trips.
    expect(row.incentive_final).toBeUndefined();
    expect(stopRows["s1"]).toEqual({ points_awarded: 6, was_repeat: false, zone_code: "A2" });
  });

  it("a second proposal loses and never overwrites the stored proposal OR evidence", async () => {
    const { row, stopRows, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await proposeTripIncentiveOnce(client, "t1", 44, anchorBreakdown());
    const rerun = collectFinalizeBreakdown([
      {
        stops: [{ id: "s1", zoneCode: "A2" }],
        result: { dropPoints: [6], wasRepeat: [false], rateUsed: 13, isOffPeak: true, deductionApplied: 0 },
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

describe("payAttributionInstant - the ONE month-bucket key for trips and money", () => {
  const pickup = new Date("2026-06-30T01:00:00Z");

  it("keys on the first delivery confirm - a 30 June pickup delivered 1 July is July money", () => {
    const delivered = new Date("2026-06-30T18:00:00Z"); // 1 Jul 02:00 MYT
    expect(
      payAttributionInstant({ pickup_datetime: pickup, stops: [{ delivered_at: delivered }] })
    ).toBe(delivered);
  });

  it("falls back to pickup when no stop has a delivery confirm", () => {
    expect(
      payAttributionInstant({ pickup_datetime: pickup, stops: [{ delivered_at: null }] })
    ).toBe(pickup);
  });
});
