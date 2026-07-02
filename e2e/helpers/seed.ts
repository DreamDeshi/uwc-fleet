/**
 * Builds trip fixtures directly through the API so each browser test starts from
 * a known state. All trips are single-stop, 1×(4×4) pallet — the smallest valid
 * booking — so any truck can carry them and the dispatch engine always finds a fit.
 */
import {
  addLeave,
  approveTrip,
  createTrip,
  deleteLeave,
  driverIdentity,
  driverStatus,
  getDriverBoard,
  getRouteTypes,
  login,
  searchConsignees,
  type Consignee,
  type Trip,
} from "./api";
import { DRIVER, REQUESTOR } from "./accounts";

// A single 4×4 pallet = 1 pallet-equivalent (api/src/lib/pallets.ts). The "×" is
// U+00D7, matching the pallet sizes the booking form stores.
export const CARGO_LINE = { pallet_type: "4×4", quantity: 1 };

export async function pickRouteType(token: string): Promise<{ id: string; name: string }> {
  const types = await getRouteTypes(token);
  if (!types.length) throw new Error("No route types configured on the API.");
  return types[0];
}

/**
 * A consignee suitable for API seeding. Prefers the given zones (e.g. ["A2"] so
 * auto-dispatch is forced onto the PLX 2406 driver, the only A-zone truck), falling
 * back to any consignee so the helper never returns empty.
 */
export async function pickConsignee(token: string, preferZones: string[] = []): Promise<Consignee> {
  for (const zone of preferZones) {
    const list = await searchConsignees(token, { zone });
    if (list.length) return list[0];
  }
  const any = await searchConsignees(token, {});
  if (!any.length) throw new Error("No consignees available to seed a trip.");
  return any[0];
}

/**
 * A consignee plus a search term that the booking UI can type to surface it.
 * Derives the term from the consignee's (display) name and re-queries the same
 * endpoint the app uses, so typing `term` in the search box is guaranteed to
 * render `display` as a tappable result.
 */
export async function pickSearchableConsignee(
  token: string
): Promise<{ term: string; display: string; id: string }> {
  const head = await searchConsignees(token, {});
  if (!head.length) throw new Error("No consignees available for the booking UI.");
  const target = head[0];
  const firstWord = target.company_name.match(/[A-Za-z0-9]{2,}/)?.[0] ?? "";
  const term = firstWord.slice(0, 5).toLowerCase();
  if (term.length < 2) throw new Error(`Could not derive a search term from "${target.company_name}".`);

  const results = await searchConsignees(token, { search: term });
  const match = results.find((c) => c.id === target.id) ?? results[0];
  if (!match) throw new Error(`Search for "${term}" returned no consignees.`);
  return { term, display: match.company_name, id: match.id };
}

// Tomorrow 09:00 Malaysia time (UTC+8). A FIXED, near-future, in-window instant:
//   - always inside the 07:00–18:00 operating window (a 1-stop run finishes
//     ~10:35), so the Phase-3 cutoff never trips manual-assign flows by wall clock;
//   - deterministic, so two trips seeded in one test share a pickup — exactly the
//     within-buffer overlap the scheduling-conflict specs rely on.
function inWindowPickupIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9 - 8, 0)
  ).toISOString();
}

/** Create a fresh PENDING trip owned by the test requestor. */
export async function seedPendingTrip(
  requestorToken: string,
  preferZones: string[] = []
): Promise<Trip> {
  const [routeType, consignee] = await Promise.all([
    pickRouteType(requestorToken),
    pickConsignee(requestorToken, preferZones),
  ]);
  return createTrip(requestorToken, {
    route_type_id: routeType.id,
    pickup_datetime: inWindowPickupIso(),
    stops: [{ consignee_id: consignee.id }],
    cargo_details: [CARGO_LINE],
  });
}

/**
 * Create a PENDING trip that auto-dispatch deterministically CANNOT place —
 * every driver is put on leave for the trip's pickup date (a far-future day no
 * other spec books), so the engine finds zero candidates and flags it
 * auto_dispatch_failed (Phase 2), independent of other drivers' live state.
 *
 * (The old fixture used an oversized 20-pallet order, but creation now rejects
 * cargo bigger than the largest truck — CARGO_EXCEEDS_FLEET, covered in
 * creationValidation.spec.ts — so an undispatchable-but-VALID booking has to
 * be forced via availability instead.)
 *
 * Returns a cleanup() that removes the leave rows; call it in `finally` so the
 * shared DB's dispatch pool is restored even when an assertion fails.
 */
export async function seedUndispatchableTrip(
  adminToken: string,
  requestorToken: string
): Promise<{ trip: Trip; cleanup: () => Promise<void> }> {
  // Pickup 45 days out at 10:00 MYT — inside the operating window (so the
  // needs-attention flag can only come from "no eligible driver") and far from
  // every other spec's pickups (no conflict-buffer interference).
  const now = new Date();
  const pickupMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 45,
    10 - 8,
    0
  );
  const pickupIso = new Date(pickupMs).toISOString();
  // The leave calendar keys on the pickup's MYT calendar day.
  const leaveDate = new Date(pickupMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const drivers = await getDriverBoard(adminToken);
  const leaveIds: string[] = [];
  for (const d of drivers) {
    const leave = await addLeave(adminToken, {
      driver_id: d.id,
      start_date: leaveDate,
      note: "e2e fixture — all drivers off for this date",
    });
    leaveIds.push(leave.id);
  }

  const trip = await seedPendingTripAt(requestorToken, pickupIso);

  return {
    trip,
    cleanup: async () => {
      for (const id of leaveIds) {
        try {
          await deleteLeave(adminToken, id);
        } catch {
          // Best-effort: an already-removed leave row must not fail the spec.
        }
      }
    },
  };
}

/**
 * Create a PENDING trip with an explicit pickup instant — used by the
 * operating-window specs to force a route that finishes past 18:00 (or a pickup
 * outside the window). 1×(4×4) pallet so capacity/zone never block it; the only
 * variable under test is the pickup time.
 */
export async function seedPendingTripAt(
  requestorToken: string,
  pickupIso: string,
  preferZones: string[] = []
): Promise<Trip> {
  const [routeType, consignee] = await Promise.all([
    pickRouteType(requestorToken),
    pickConsignee(requestorToken, preferZones),
  ]);
  return createTrip(requestorToken, {
    route_type_id: routeType.id,
    pickup_datetime: pickupIso,
    stops: [{ consignee_id: consignee.id }],
    cargo_details: [CARGO_LINE],
  });
}

/** Create a trip already ASSIGNED to the test driver (PLX 2406). */
export async function seedAssignedTrip(adminToken: string): Promise<Trip> {
  const requestor = await login(REQUESTOR);
  const trip = await seedPendingTrip(requestor.accessToken);
  const driver = await driverIdentity(DRIVER);
  return approveTrip(adminToken, trip.id, { driver_id: driver.id, truck_plate: driver.plate });
}

/** Assigned → IN PROGRESS (driver pressed start), with its single stop ARRIVED. */
export async function seedArrivedTrip(adminToken: string): Promise<{ trip: Trip; stopId: string }> {
  const assigned = await seedAssignedTrip(adminToken);
  const driver = await driverIdentity(DRIVER);
  await driverStatus(driver.token, assigned.id, "start");
  const stop = assigned.stops[0];
  const trip = await driverStatus(driver.token, assigned.id, "arrived", stop.id);
  return { trip, stopId: stop.id };
}
