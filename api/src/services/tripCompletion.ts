import { ApiError } from "../lib/apiError";
import type { DeliveryIncentiveResult } from "./incentiveEngine";

/**
 * Delivery / finalization guards for PATCH /trips/:id/status (action=delivered),
 * factored out — same pattern as tripAssignment.ts — so the money-protecting
 * behaviour can be unit-tested without a database.
 *
 * A trip's incentive_earned must be written exactly once, at completion.
 * Re-running finalization later would recompute at the CURRENT truck rates and
 * the CURRENT day ledger, silently changing already-finalized pay (e.g.
 * re-posting "delivered" on a completed RM44 Ipoh trip after a second same-day
 * trip re-scores it with no daily deduction → RM66).
 */

/**
 * A stop may be marked ARRIVED only while it is still pending and its trip is
 * actually out (in_progress). Factored from the route's inline checks (same
 * checks, same order) so the guard is unit-testable without a database —
 * mirroring assertStopDeliverable below.
 *
 * ORDER IS LOAD-BEARING: the stop-status check fires FIRST, so a genuine
 * "already arrived/delivered" retry returns INVALID_STATUS even when the trip
 * is no longer in_progress (e.g. completed). The mobile offline outbox treats
 * INVALID_STATUS on the arrived step as "already done → proceed"
 * (ARRIVED_STEP_ALREADY_CODES); if a non-pending stop on a finished trip
 * returned TRIP_NOT_STARTED instead, a replayed outbox would treat a completed
 * step as a hard failure and wedge. Pinned by tests/tripCompletion.test.ts and
 * tests-integration/arrivedGuard.test.ts.
 */
export function assertStopArrivable(
  trip: { status: string },
  stop: { status: string }
): void {
  if (stop.status !== "pending") {
    throw new ApiError(400, "INVALID_STATUS", "This stop has already been marked arrived.");
  }
  // Lifecycle order: assigned → started → arrived → delivered. Fires only for
  // a still-pending stop on a not-yet-started (or no-longer-active) trip; the
  // outbox never queues arrived before an online start, so the normal offline
  // flow (trip already in_progress) never hits it.
  if (trip.status !== "in_progress") {
    throw new ApiError(400, "TRIP_NOT_STARTED", "Start the trip before marking a stop as arrived.");
  }
}

/**
 * A stop may be marked delivered only while its trip is actually out
 * (in_progress), and only once. Throws the canonical 409s otherwise.
 */
export function assertStopDeliverable(
  trip: { status: string },
  stop: { status: string }
): void {
  if (trip.status !== "in_progress") {
    throw new ApiError(
      409,
      "TRIP_NOT_ACTIVE",
      "Stops can only be marked delivered while the trip is in progress."
    );
  }
  if (stop.status === "delivered") {
    throw new ApiError(
      409,
      "STOP_ALREADY_DELIVERED",
      "This stop has already been marked delivered."
    );
  }
}

/**
 * The RM a COMPLETED trip actually pays. Under the POD-approval gate (16 Jul
 * 2026) that is the admin-approved `incentive_final`; a trip completed BEFORE
 * the gate has `incentive_final = null` and is paid at its engine proposal
 * `incentive_earned` (grandfathered — no data migration). This is the ONE
 * function every "what did this trip pay" read must use. Only meaningful for
 * `completed` trips; a `pending_approval` proposal is not yet payable.
 */
export function payableIncentive(t: { incentive_final?: unknown; incentive_earned?: unknown }): number {
  return Number(t.incentive_final ?? t.incentive_earned ?? 0);
}

// ── Per-drop pay evidence (clerk verification) ────────────────────────────
//
// The engine already computes per-drop points, the repeat flag, the rate tier
// and the deduction actually applied; historically only the summed RM was
// stored, so "I did Ipoh first, why 1 point?" was unanswerable from the data.
// collectFinalizeBreakdown re-shapes the engine's OWN outputs (no
// recomputation, no rule change) into the columns finalizeTripOnce persists
// alongside incentive_earned.

/** One finalized day-group: the stops scored (in scoring order) + the engine's result. */
export interface FinalizedGroup {
  stops: { id: string; zoneCode: string }[]; // index-aligned with result.dropPoints
  result: Pick<
    DeliveryIncentiveResult,
    "dropPoints" | "wasRepeat" | "rateUsed" | "isOffPeak" | "deductionApplied"
  >;
}

export interface FinalizeBreakdown {
  /** Written onto the Trip row (all nullable columns). */
  tripData: {
    rate_used: number | null;
    off_peak: boolean | null;
    deduction_applied: number;
  };
  /** Written onto each TripStop row. */
  stopRows: { id: string; points_awarded: number; was_repeat: boolean; zone_code: string }[];
}

export function collectFinalizeBreakdown(groups: FinalizedGroup[]): FinalizeBreakdown {
  const stopRows = groups.flatMap((g) =>
    g.stops.map((s, i) => ({
      id: s.id,
      points_awarded: g.result.dropPoints[i],
      was_repeat: g.result.wasRepeat[i],
      // Snapshot the zone the drop was actually scored against — a later
      // consignee zone correction must not rewrite pay history.
      zone_code: s.zoneCode,
    }))
  );
  // A trip normally finalizes as ONE delivery-day group. The rare
  // midnight-straddler splits into groups that can use different rate tiers —
  // a single trip-level rate/off_peak would then be wrong for half the drops,
  // so those two columns stay NULL ("breakdown not recorded" at trip level;
  // the per-stop rows are still exact). The deduction is well-defined either
  // way: each group applied its own day's deduction, so it sums.
  const single = groups.length === 1 ? groups[0].result : null;
  return {
    tripData: {
      rate_used: single ? single.rateUsed : null,
      off_peak: single ? single.isOffPeak : null,
      deduction_applied: groups.reduce((sum, g) => sum + g.result.deductionApplied, 0),
    },
    stopRows,
  };
}

/**
 * The trip's FIRST delivery confirm — the day-group anchor the rate tier
 * (weekday/off-peak) and pay-day attribution keyed on at finalization.
 * Surfaced on earnings payloads so an 18:05-boundary dispute is resolvable
 * without digging through status history. Pure.
 */
export function firstDeliveredAt(stops: { delivered_at: Date | null }[]): Date | null {
  return stops.reduce<Date | null>(
    (earliest, s) =>
      s.delivered_at && (!earliest || s.delivered_at < earliest) ? s.delivered_at : earliest,
    null
  );
}

/**
 * The instant a trip's month bucket keys on: the first delivery confirm — the
 * same anchor finalization wrote the day ledger and pay against. Pay is
 * earned on the DELIVERY day, so a trip picked up 30 June and delivered
 * 1 July is July money; bucketing reports by any other date makes a report
 * and the payroll sheet disagree about the same trip. Falls back to pickup
 * only where no delivery confirm exists (not-yet-delivered, external, or the
 * legacy null-delivered_at anomaly surfaced by /reports/attention).
 */
export function payAttributionInstant(trip: {
  pickup_datetime: Date;
  stops: { delivered_at: Date | null }[];
}): Date {
  return firstDeliveredAt(trip.stops) ?? trip.pickup_datetime;
}

// Minimal slice of the Prisma client the propose/approve steps need. Lets tests
// substitute an in-memory store that models the atomic conditional update.
export interface TripFinalizeClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "in_progress" | "pending_approval"; incentive_earned?: null };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  tripStop: {
    updateMany(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * PROPOSE the incentive (POD-approval gate, 16 Jul 2026): flip
 * in_progress → pending_approval and persist the ENGINE-COMPUTED incentive plus
 * the per-drop breakdown, as a write-once compare-and-set (same shape as
 * claimPendingTrip). The amount is frozen here (`incentive_earned`, computed at
 * delivery under that day's ledger + snapshot rates) but NOT yet paid — payroll
 * only counts `completed` trips. Returns true iff THIS caller proposed; a trip
 * already past in_progress (or already carrying an incentive) is never
 * overwritten, and a loser never touches the stop rows. One transaction, so the
 * proposal and its evidence commit atomically.
 *
 * (Was `finalizeTripOnce`, which flipped straight to `completed`; the approval
 * step below now owns the completed transition + the payable amount.)
 */
export async function proposeTripIncentiveOnce(
  client: TripFinalizeClient,
  tripId: string,
  incentiveThisTrip: number,
  breakdown: FinalizeBreakdown
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "in_progress", incentive_earned: null },
    data: {
      status: "pending_approval",
      incentive_earned: incentiveThisTrip,
      ...breakdown.tripData,
    },
  });
  if (res.count !== 1) return false;
  for (const row of breakdown.stopRows) {
    const { id, ...data } = row;
    await client.tripStop.updateMany({ where: { id }, data });
  }
  return true;
}

/**
 * A trip's incentive may be approved only while it is `pending_approval` (all
 * stops delivered, proposal computed, not yet paid). The admin may confirm the
 * proposal as-is or edit the final amount — an edit REQUIRES a reason (the
 * original proposal in `incentive_earned` is preserved). Pure guard, throws the
 * canonical 400s so it is unit-testable without a DB.
 */
export function assertIncentiveApprovable(
  trip: { status: string; incentive_earned: unknown },
  finalAmount: number | undefined,
  reason: string | undefined
): void {
  if (trip.status !== "pending_approval") {
    throw new ApiError(
      409,
      "TRIP_NOT_PENDING_APPROVAL",
      "Only a delivered trip awaiting approval can be approved."
    );
  }
  if (finalAmount !== undefined) {
    if (!Number.isFinite(finalAmount) || finalAmount < 0) {
      throw new ApiError(400, "INVALID_AMOUNT", "The final amount must be zero or more.");
    }
    const proposed = Number(trip.incentive_earned ?? 0);
    const edited = Math.round(finalAmount * 100) !== Math.round(proposed * 100);
    if (edited && !(reason && reason.trim().length > 0)) {
      throw new ApiError(400, "REASON_REQUIRED", "A reason is required when editing the final amount.");
    }
  }
}

export interface TripApproveClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "pending_approval" };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * APPROVE the incentive: flip pending_approval → completed and set the payable
 * `incentive_final` (= the proposal, or an admin-edited amount + reason). The
 * proposal `incentive_earned` is never overwritten. Write-once CAS on
 * pending_approval — a concurrent approval loses. Returns true iff THIS caller
 * approved. `proposedAmount` is the trip's stored `incentive_earned`; the final
 * defaults to it when the admin doesn't edit.
 */
export async function approveTripIncentiveOnce(
  client: TripApproveClient,
  tripId: string,
  opts: { proposedAmount: number; finalAmount?: number; reason?: string; adminId: string; approvedAt: Date }
): Promise<boolean> {
  const final = opts.finalAmount === undefined ? opts.proposedAmount : Math.round(opts.finalAmount * 100) / 100;
  const edited = Math.round(final * 100) !== Math.round(opts.proposedAmount * 100);
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "pending_approval" },
    data: {
      status: "completed",
      incentive_final: final,
      incentive_override_reason: edited ? (opts.reason ?? null) : null,
      incentive_approved_at: opts.approvedAt,
      incentive_approved_by: opts.adminId,
    },
  });
  return res.count === 1;
}
