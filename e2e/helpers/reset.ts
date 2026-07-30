/**
 * Per-test reset. Brings the shared backend to a clean, deterministic state
 * before each spec runs:
 *   1. dispatch mode → manual (so newly seeded trips stay pending until a test
 *      explicitly assigns or auto-dispatches them);
 *   2. the test driver (the test driver) is freed — any active trip (assigned or in_progress)
 *      is driven to completion via the API, so each spec starts from a clean slate
 *      (an in_progress trip would otherwise block a fresh assignment with 409
 *      DRIVER_BUSY; a leftover assigned trip would trip the SCHEDULING_CONFLICT
 *      buffer — both are avoided by completing them here);
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
  getOpenExceptions,
  getTrips,
  login,
  markStopDocs,
  resumeException,
  setDispatchMode,
  uploadK2,
  uploadPod,
} from "./api";
import { ADMIN, DRIVER } from "./accounts";
import { POD_FILE } from "./pod";

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
      // Satisfy the documentation gate the same way the driver app does: a
      // REAL photo upload (sets pod_photo and flips do_uploaded server-side —
      // the flag can no longer be self-attested, 400 POD_PHOTO_REQUIRED), plus
      // the K2 customs ack, which is still a legitimate checkbox on its own.
      // A stop that needs the Borang K2 customs document additionally requires
      // it UPLOADED (R1 Q6 — the ack alone no longer satisfies the gate).
      //
      // That is NOT zone "K2" (Sungai Petani/Kedah, which never needs the
      // form): the rule is zone "P1" AND an `area` containing "BAYAN LEPAS"
      // (owner decision 29 Jul). Keying on the zone code left reset unable to
      // close a real Bayan Lepas trip — the server rejects `delivered` with
      // DOCUMENTATION_INCOMPLETE and every later spec inherits the stuck trip.
      // Delivering the last stop completes the trip.
      await uploadPod(accessToken, trip.id, stop.id, POD_FILE);
      const needsCustomsDoc =
        stop.consignee?.zone_code === "P1" &&
        (stop.consignee?.area ?? "").toUpperCase().includes("BAYAN LEPAS");
      if (needsCustomsDoc) {
        await uploadK2(accessToken, trip.id, stop.id, POD_FILE);
      }
      await markStopDocs(accessToken, trip.id, stop.id, { k2_form_ack: true });
      await driverStatus(accessToken, trip.id, "delivered", stop.id);
    }
  }
}

/**
 * Close every open exception (admin, via RESUME — the Phase-1 action legal
 * from any open state). An open exception blocks `delivered` on its trip
 * (409 EXCEPTION_OPEN), which would wedge freeDriver — so this runs FIRST in
 * the reset. No-op while the feature flag is off (the routes 404 and the
 * catch swallows it).
 */
export async function resolveOpenExceptions(adminToken: string): Promise<void> {
  try {
    const { exceptions } = await getOpenExceptions(adminToken);
    for (const exc of exceptions) {
      try {
        await resumeException(adminToken, exc.trip_id, exc.id);
      } catch {
        // Best-effort: a concurrent transition must not fail the reset.
      }
    }
  } catch {
    // FEATURE_EXCEPTIONS off → the endpoint 404s; nothing to clean.
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
  await resolveOpenExceptions(admin.accessToken);
  await freeDriver();
  await cancelOpenTrips(admin.accessToken);
  return { adminToken: admin.accessToken };
}
