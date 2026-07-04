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

// Minimal slice of the Prisma client the finalize needs. Lets tests substitute
// an in-memory store that models the atomic conditional update.
export interface TripFinalizeClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "in_progress"; incentive_earned: null };
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
 * Flip in_progress → completed and persist the trip's incentive plus the
 * per-drop breakdown, as a write-once compare-and-set (same shape as
 * claimPendingTrip): only the writer that still sees the trip in_progress with
 * no incentive wins. Returns true iff THIS caller finalized the trip; a
 * completed / already-finalized trip is never overwritten — and a loser never
 * touches the stop rows either. Run inside one transaction so the incentive
 * and its evidence commit atomically.
 */
export async function finalizeTripOnce(
  client: TripFinalizeClient,
  tripId: string,
  incentiveThisTrip: number,
  breakdown: FinalizeBreakdown
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "in_progress", incentive_earned: null },
    data: {
      status: "completed",
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
