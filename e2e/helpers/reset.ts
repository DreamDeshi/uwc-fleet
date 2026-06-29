/**
 * Per-test reset. Brings the shared backend to a clean, deterministic state
 * before each spec runs:
 *   1. dispatch mode → manual (so newly seeded trips stay pending until a test
 *      explicitly assigns or auto-dispatches them);
 *   2. the test driver (Driver 1) is freed — any active trip is driven to completion
 *      via the API, because the "one active trip per driver" rule would otherwise
 *      reject a fresh assignment with 409 DRIVER_BUSY;
 *   3. all still-open (pending/approved) trips are cancelled to keep the boards tidy.
 *
 * Trips already assigned to OTHER drivers can't be cancelled (the API only allows
 * cancelling pending/approved), so each spec scopes its assertions to the specific
 * ticket it created rather than assuming a globally empty board. For a true blank
 * slate between full runs, use `npm run seed-clean` in the api workspace.
 */
import {
  cancelTrip,
  driverStatus,
  getTrips,
  login,
  markStopDocs,
  setDispatchMode,
} from "./api";
import { ADMIN, DRIVER } from "./accounts";

const ACTIVE: string[] = ["assigned", "in_progress"];

/** Drive every active trip for the test driver to completion, freeing them. */
export async function freeDriver(): Promise<void> {
  const { accessToken } = await login(DRIVER);
  const trips = await getTrips(accessToken);
  for (const trip of trips) {
    if (!ACTIVE.includes(trip.status)) continue;
    if (trip.status === "assigned") {
      await driverStatus(accessToken, trip.id, "start");
    }
    const stops = [...(trip.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
    for (const stop of stops) {
      if (stop.status === "delivered") continue;
      // Satisfy the documentation gate (DO photo + K2 ack) without a real upload,
      // then mark delivered. Delivering the last stop completes the trip.
      await markStopDocs(accessToken, trip.id, stop.id, { do_uploaded: true, k2_form_ack: true });
      await driverStatus(accessToken, trip.id, "delivered", stop.id);
    }
  }
}

/** Cancel all pending/approved trips (any requestor) — admin can cancel any trip. */
export async function cancelOpenTrips(adminToken: string): Promise<void> {
  const trips = await getTrips(adminToken);
  for (const trip of trips) {
    if (trip.status === "pending" || trip.status === "approved") {
      try {
        await cancelTrip(adminToken, trip.id);
      } catch {
        // Best-effort: a concurrent transition can make a trip un-cancellable.
      }
    }
  }
}

/** Full reset. Returns a fresh admin token for the spec to reuse. */
export async function resetState(): Promise<{ adminToken: string }> {
  const admin = await login(ADMIN);
  await setDispatchMode(admin.accessToken, "manual");
  await freeDriver();
  await cancelOpenTrips(admin.accessToken);
  return { adminToken: admin.accessToken };
}
