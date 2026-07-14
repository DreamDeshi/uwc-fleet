/**
 * Booking → dispatch → delivery flow helpers for the integration suite, built
 * on the real HTTP API (via the supertest harness). These drive a trip through
 * its lifecycle so the money/finalize path can be exercised end-to-end.
 *
 * The one shortcut: the POD photo (a Cloudinary upload in production) is written
 * straight onto the stop row instead of going through the multipart upload —
 * the money path under test only cares that the documentation gate is satisfied,
 * not how the photo got stored. Everything else is a genuine API call.
 */
import { api, auth, prisma } from "./harness";

export async function userIdByPhone(phone: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { phone } });
  if (!u) throw new Error(`user ${phone} not found in the test DB`);
  return u.id;
}

export async function firstRouteTypeId(token: string): Promise<string> {
  const res = await api().get("/api/v1/route-types").set(auth(token));
  if (res.status !== 200 || !res.body.length) {
    throw new Error(`route-types failed: ${res.status} ${res.text}`);
  }
  return res.body[0].id;
}

export async function consigneeInZone(
  token: string,
  zone: string
): Promise<{ id: string; zone_code: string }> {
  const res = await api().get(`/api/v1/consignees?zone=${encodeURIComponent(zone)}`).set(auth(token));
  if (res.status !== 200) throw new Error(`consignees failed: ${res.status} ${res.text}`);
  const c = res.body.find((x: { zone_code: string }) => x.zone_code === zone) ?? res.body[0];
  if (!c) throw new Error(`no consignee available in zone ${zone}`);
  return c;
}

/** Tomorrow 09:00 Malaysia time — deterministic, inside the operating window. */
export function futurePickupIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9 - 8, 0)
  ).toISOString();
}

export interface FlowStop {
  id: string;
  sequence: number;
  consignee_id: string;
}
export interface FlowTrip {
  id: string;
  status: string;
  stops: FlowStop[];
  [k: string]: unknown;
}

/** Book a (multi-)stop trip owned by the requestor: one consignee per zone. */
export async function bookTrip(token: string, zones: string[], routeTypeId: string): Promise<FlowTrip> {
  const consignees = await Promise.all(zones.map((z) => consigneeInZone(token, z)));
  const res = await api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: routeTypeId,
      pickup_datetime: futurePickupIso(),
      stops: consignees.map((c, i) => ({ consignee_id: c.id, sequence: i + 1 })),
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
  if (res.status !== 201) throw new Error(`book failed: ${res.status} ${res.text}`);
  return res.body;
}

/** Admin assigns a pending trip to a driver + truck (force skips warnings). */
export async function approveTrip(
  adminToken: string,
  tripId: string,
  driverId: string,
  plate: string
): Promise<FlowTrip> {
  const res = await api()
    .patch(`/api/v1/trips/${tripId}/approve`)
    .set(auth(adminToken))
    .send({ driver_id: driverId, truck_plate: plate, force: true });
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${res.text}`);
  return res.body;
}

export async function startTrip(driverToken: string, tripId: string): Promise<FlowTrip> {
  const res = await api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "start" });
  if (res.status !== 200) throw new Error(`start failed: ${res.status} ${res.text}`);
  return res.body;
}

/**
 * Arrive at a stop, satisfy the POD gate (stubbed photo), then mark delivered.
 * Delivering the LAST stop triggers finalization (incentive computation).
 */
export async function arriveAndDeliver(
  driverToken: string,
  tripId: string,
  stopId: string
): Promise<FlowTrip> {
  const arrived = await api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "arrived", stop_id: stopId });
  if (arrived.status !== 200) throw new Error(`arrived failed: ${arrived.status} ${arrived.text}`);

  // Stub the POD photo the documentation gate requires (isDocumentationComplete
  // checks pod_photo + do_uploaded). No money rule depends on the photo itself.
  await prisma.tripStop.update({
    where: { id: stopId },
    data: { pod_photo: "test://pod.jpg", do_uploaded: true },
  });

  const delivered = await api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "delivered", stop_id: stopId });
  if (delivered.status !== 200) throw new Error(`delivered failed: ${delivered.status} ${delivered.text}`);
  return delivered.body;
}

/** Sorted stops (by sequence) — the create response order isn't guaranteed. */
export function stopsBySequence(trip: FlowTrip): FlowStop[] {
  return [...trip.stops].sort((a, b) => a.sequence - b.sequence);
}

export const num = (v: unknown): number => Number(v);
