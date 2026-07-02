import { ApiError } from "../lib/apiError";

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

// Minimal slice of the Prisma client the finalize needs. Lets tests substitute
// an in-memory store that models the atomic conditional update.
export interface TripFinalizeClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "in_progress"; incentive_earned: null };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Flip in_progress → completed and persist the trip's incentive, as a
 * write-once compare-and-set (same shape as claimPendingTrip): only the writer
 * that still sees the trip in_progress with no incentive wins. Returns true iff
 * THIS caller finalized the trip; a completed / already-finalized trip is never
 * overwritten.
 */
export async function finalizeTripOnce(
  client: TripFinalizeClient,
  tripId: string,
  incentiveThisTrip: number
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "in_progress", incentive_earned: null },
    data: { status: "completed", incentive_earned: incentiveThisTrip },
  });
  return res.count === 1;
}
