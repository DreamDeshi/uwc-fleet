import { ApiError } from "../lib/apiError";

/**
 * Atomic "claim a pending trip" primitive shared by the manual approve endpoint
 * and the auto-dispatch engine, factored out so the concurrency behaviour can be
 * unit-tested without a database.
 *
 * The claim is a status-guarded conditional update — updateMany scoped to
 * `{ id, status: "pending" }`. Postgres makes this a compare-and-set: among
 * concurrent transactions exactly one still sees the row as pending and flips it
 * (count 1); the rest match nothing (count 0). That deterministically prevents
 * two admins (or the background sweep) from assigning the same trip twice.
 */

// Minimal slice of the Prisma client the claim needs. Lets tests substitute an
// in-memory store that models the atomic conditional update.
export interface TripClaimClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "pending" };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Flip a trip pending → assigned, writing `data` alongside. Returns true iff THIS
 * caller won the claim (the row was still pending). A losing caller gets false.
 */
export async function claimPendingTrip(
  client: TripClaimClient,
  tripId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "pending" },
    data: { ...data, status: "assigned" },
  });
  return res.count === 1;
}

/**
 * Same as claimPendingTrip but throws the canonical 409 when another assignment
 * won the race (used by the request-handling path; the engine uses the boolean
 * form so it can stay best-effort).
 */
export async function claimPendingTripOrThrow(
  client: TripClaimClient,
  tripId: string,
  data: Record<string, unknown>
): Promise<void> {
  const won = await claimPendingTrip(client, tripId, data);
  if (!won) {
    throw new ApiError(
      409,
      "CONCURRENT_ASSIGNMENT",
      "This booking was just assigned by someone else. Refresh and try again."
    );
  }
}

// ── Release: the mirror of the claim (admin unassign/reassign lever) ──────

// Minimal client slice for the release CAS (same pattern as TripClaimClient).
export interface TripReleaseClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: "assigned" };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Everything an unassign must clear so the trip re-enters the pending flow as
 * if it had never been dispatched:
 *  - driver/truck freed;
 *  - the assignment-time rate/zone snapshots dropped (they belong to the OLD
 *    truck — the next assignment re-takes them at ITS truck and moment);
 *  - pending_alert_sent reset so the pending sweep re-alerts admins (and, in
 *    auto mode, retries auto-dispatch) if the trip sits unassigned again;
 *  - auto_dispatch_failed cleared (the flag self-clears on any pending exit
 *    and must not carry stale state back in).
 */
export const RELEASE_TRIP_DATA = {
  status: "pending",
  driver_id: null,
  truck_plate: null,
  entitled_claim_weekday: null,
  entitled_claim_offpeak: null,
  daily_deduction_points: null,
  pending_alert_sent: false,
  auto_dispatch_failed: false,
} as const;

/**
 * Flip a trip assigned → pending (the admin "unassign" lever, client-approved
 * 3 Jul 2026), as a status-guarded compare-and-set: only a trip still sitting
 * in `assigned` can be released. Returns true iff THIS caller released it —
 * an in_progress trip (driver already started) never matches, which is what
 * keeps this lever scoped to not-yet-started trips.
 */
export async function releaseAssignedTrip(
  client: TripReleaseClient,
  tripId: string
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: "assigned" },
    data: { ...RELEASE_TRIP_DATA },
  });
  return res.count === 1;
}
