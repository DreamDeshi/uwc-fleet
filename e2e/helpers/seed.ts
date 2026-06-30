/**
 * Builds trip fixtures directly through the API so each browser test starts from
 * a known state. All trips are single-stop, 1×(4×4) pallet — the smallest valid
 * booking — so any truck can carry them and the dispatch engine always finds a fit.
 */
import {
  approveTrip,
  createTrip,
  driverIdentity,
  driverStatus,
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
 * auto-dispatch is forced onto Azmi/PLX 2406, the only A-zone truck), falling
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
    // A near-future weekday-ish pickup; only its existence matters for these flows.
    pickup_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    stops: [{ consignee_id: consignee.id }],
    cargo_details: [CARGO_LINE],
  });
}

/**
 * Create a PENDING trip whose cargo exceeds the largest truck (PLX 2406 = 16
 * 4×4 pallets), so NO truck can ever fit it. In auto mode the dispatch engine
 * finds no eligible truck and flags it auto_dispatch_failed (Phase 2); it also
 * can't be assigned manually (the overload guard blocks it), making it a clean,
 * deterministic "needs attention" fixture independent of other drivers' state.
 */
export async function seedOversizedTrip(
  requestorToken: string,
  preferZones: string[] = []
): Promise<Trip> {
  const [routeType, consignee] = await Promise.all([
    pickRouteType(requestorToken),
    pickConsignee(requestorToken, preferZones),
  ]);
  return createTrip(requestorToken, {
    route_type_id: routeType.id,
    pickup_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    stops: [{ consignee_id: consignee.id }],
    cargo_details: [{ pallet_type: "4×4", quantity: 20 }], // 20 > 16 → fits no truck
  });
}

/** Create a trip already ASSIGNED to the test driver (Azmi / PLX 2406). */
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
