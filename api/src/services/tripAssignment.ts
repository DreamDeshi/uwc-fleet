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
  auto_dispatch_note: null,
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

// ── Exits: reject / cancel / assign-external, status-guarded like the claim ──
//
// These three used to be plain update-by-id behind a pre-check, which loses to
// the 60s auto-dispatch sweep (or another admin): the sweep claims the trip
// pending → assigned with a driver + rate snapshot, and the blind update then
// stamps rejected/cancelled/outsourced ON TOP — leaving e.g. an "outsourced"
// trip that still carries an internal driver and frozen rates, or a cancelled
// trip with a driver attached. Same CAS discipline as claim/release: the
// mutation applies only while the trip is still in the expected status; a
// lost race returns false and the route answers 409 TRIP_STATE_CHANGED.

// Minimal client slice for the exit CASes (same pattern as TripClaimClient).
// Includes "in_progress" for the admin abort lever (abortActiveTrip).
export interface TripExitClient {
  trip: {
    updateMany(args: {
      where: { id: string; status: { in: ("pending" | "approved" | "in_progress")[] } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Reject a still-pending booking. Returns true iff THIS caller flipped it —
 * a trip auto-dispatch just assigned (or anyone else moved) never matches.
 */
export async function rejectPendingTrip(
  client: TripExitClient,
  tripId: string,
  reason: string | null
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: { in: ["pending"] } },
    // Leaving pending clears the needs-attention flag (Phase 2 self-clearing).
    data: {
      status: "rejected",
      rejection_reason: reason,
      auto_dispatch_failed: false,
      auto_dispatch_note: null,
    },
  });
  return res.count === 1;
}

/**
 * Cancel a booking that has not been dispatched (pending/approved — the same
 * statuses the route's pre-check allows). A trip that just went `assigned`
 * never matches, so a cancelled trip can never end up with a driver attached.
 */
export async function cancelBookedTrip(
  client: TripExitClient,
  tripId: string
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: { in: ["pending", "approved"] } },
    data: { status: "cancelled", auto_dispatch_failed: false, auto_dispatch_note: null },
  });
  return res.count === 1;
}

/**
 * Admin abort of an IN-PROGRESS trip (the de-orphan lever). Returns true iff
 * THIS caller flipped it — a trip that just COMPLETED (last stop delivered) or
 * was already cancelled never matches, so an abort can never overwrite a
 * finalized/paid trip. Sets `cancelled`, which frees the truck's dispatch
 * capacity; deliberately does NOT touch incentive fields — an abandoned trip
 * doesn't pay (same as any cancel), so the money path is untouched. The truck
 * plate/driver stay on the row for history (the cancelled status excludes it
 * from every occupancy/candidate query).
 */
export async function abortActiveTrip(
  client: TripExitClient,
  tripId: string
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: { in: ["in_progress"] } },
    data: { status: "cancelled", auto_dispatch_failed: false, auto_dispatch_note: null },
  });
  return res.count === 1;
}

/**
 * Outsource a still-pending booking to an external forwarder. Guarded like
 * the internal claim it races against: if auto-dispatch (or another admin)
 * won, this returns false — the trip keeps its internal driver + rate
 * snapshot and no external flag is stamped over them. Run it INSIDE the same
 * transaction as the forwarder-detail upsert, and first, so a lost race
 * leaves no orphaned forwarder row either.
 */
export async function outsourcePendingTrip(
  client: TripExitClient,
  tripId: string
): Promise<boolean> {
  const res = await client.trip.updateMany({
    where: { id: tripId, status: { in: ["pending"] } },
    data: {
      status: "assigned",
      is_external: true,
      auto_dispatch_failed: false,
      auto_dispatch_note: null,
    },
  });
  return res.count === 1;
}

// ── Start: the driver's assigned → in_progress transition ─────────────────

export type StartTripOutcome = "started" | "driver_busy" | "state_changed";

// Minimal client slice for the start CAS (same pattern as TripClaimClient).
export interface TripStartClient {
  trip: {
    updateMany(args: {
      where: {
        id: string;
        status: "assigned";
        driver_id: string;
        driver: {
          is: { trips_driven: { none: { status: "in_progress"; id: { not: string } } } };
        };
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    count(args: {
      where: { driver_id: string; status: "in_progress"; id: { not: string } };
    }): Promise<number>;
  };
}

/**
 * Start an assigned trip — enforcing the one-active-trip model at the START
 * transition, not just at assignment: a driver may HOLD several `assigned`
 * trips (assign ≠ start), but may be OUT on only ONE `in_progress` trip, so
 * starting a second while one is rolling must fail. The one-active invariant
 * matters to MONEY, not just ops: the finalize day-ledger relies on a
 * driver's deliveries being serialised (a second concurrent trip is how the
 * double-first-drop / double-deduction overpay arises).
 *
 * The whole guard lives INSIDE the conditional update's where — the trip must
 * still be `assigned`, still this driver's, and the driver must have no OTHER
 * `in_progress` trip — so check and write are one atomic statement: two
 * interleaved starts can never both match. (For two starts hitting truly
 * simultaneous snapshots the route additionally runs this under Serializable
 * isolation, where one of them aborts with P2034 → 409.)
 *
 * On a lost CAS a follow-up read picks the precise error: `driver_busy` when
 * another in_progress trip exists, else `state_changed` (the trip itself left
 * `assigned` — e.g. an admin unassigned it, or this is a duplicate start).
 */
export async function startAssignedTripForDriver(
  client: TripStartClient,
  tripId: string,
  driverId: string
): Promise<StartTripOutcome> {
  const res = await client.trip.updateMany({
    where: {
      id: tripId,
      status: "assigned",
      driver_id: driverId,
      driver: {
        is: { trips_driven: { none: { status: "in_progress", id: { not: tripId } } } },
      },
    },
    data: { status: "in_progress" },
  });
  if (res.count === 1) return "started";

  const otherActive = await client.trip.count({
    where: { driver_id: driverId, status: "in_progress", id: { not: tripId } },
  });
  return otherActive > 0 ? "driver_busy" : "state_changed";
}
