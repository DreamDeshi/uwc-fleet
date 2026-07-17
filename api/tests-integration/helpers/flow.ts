/**
 * Booking → dispatch → delivery flow helpers for the integration suite, built
 * on the real HTTP API (via the supertest harness). These drive a trip through
 * its lifecycle so the money/dispatch paths can be exercised end-to-end.
 *
 * The one shortcut: the POD photo (a Cloudinary upload in production) is written
 * straight onto the stop row instead of going through the multipart upload —
 * the paths under test only care that the documentation gate is satisfied, not
 * how the photo got stored. Everything else is a genuine API call.
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

/**
 * A consignee in `zone`, created if the zone has none yet (via Prisma — test
 * setup, not the money/dispatch path). The synthetic seed covers the Penang/
 * Kedah/Perak zones + KL; any other zone is materialised on demand. The zone
 * must exist as a Zone row (all spec zones are seeded, incl. KL).
 */
export async function ensureConsigneeInZone(zone: string): Promise<{ id: string; zone_code: string }> {
  const existing = await prisma.consignee.findFirst({ where: { zone_code: zone, is_active: true } });
  if (existing) return existing;
  return prisma.consignee.create({
    data: {
      company_name: `Test Consignee ${zone} (ad-hoc)`,
      zone_code: zone,
      is_active: true,
      vendor_code: `TEST-${zone}`,
    },
  });
}

/** Tomorrow 09:00 Malaysia time — deterministic, inside the operating window. */
export function futurePickupIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9 - 8, 0)
  ).toISOString();
}

/** The MYT "YYYY-MM-DD" day of futurePickupIso() — for driver-leave setup. */
export function pickupDateKey(): string {
  const pickupMs = new Date(futurePickupIso()).getTime();
  return new Date(pickupMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface CargoLine {
  pallet_type: string;
  quantity: number;
  estimated_pallets?: number;
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

const DEFAULT_CARGO: CargoLine[] = [{ pallet_type: "4×4", quantity: 1 }];

/** Book a (multi-)stop trip owned by the requestor: one consignee per zone. */
export async function bookTrip(
  token: string,
  zones: string[],
  routeTypeId: string,
  cargo: CargoLine[] = DEFAULT_CARGO
): Promise<FlowTrip> {
  const consignees = await Promise.all(zones.map((z) => ensureConsigneeInZone(z)));
  const res = await api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: routeTypeId,
      pickup_datetime: futurePickupIso(),
      stops: consignees.map((c, i) => ({ consignee_id: c.id, sequence: i + 1 })),
      cargo_details: cargo,
    });
  if (res.status !== 201) throw new Error(`book failed: ${res.status} ${res.text}`);
  return res.body;
}

/** Run the auto-dispatch engine for one pending trip. Returns the raw response
 *  (200 with the assignment, or 409 NO_TRUCK_AVAILABLE when nothing fits). */
export function autoDispatch(adminToken: string, tripId: string) {
  return api().post("/api/v1/dispatch/auto").set(auth(adminToken)).send({ trip_id: tripId });
}

/** Manual assign — RAW response, so guard-ladder tests can assert error codes. */
export function approveRaw(
  adminToken: string,
  tripId: string,
  driverId: string,
  plate: string,
  force = false
) {
  return api()
    .patch(`/api/v1/trips/${tripId}/approve`)
    .set(auth(adminToken))
    .send({ driver_id: driverId, truck_plate: plate, force });
}

/** Admin assigns a pending trip (throws on non-200 — happy path). */
export async function approveTrip(
  adminToken: string,
  tripId: string,
  driverId: string,
  plate: string,
  force = true
): Promise<FlowTrip> {
  const res = await approveRaw(adminToken, tripId, driverId, plate, force);
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${res.text}`);
  return res.body;
}

/** Start a trip — RAW response, for concurrency tests that race starts. */
export function startRaw(driverToken: string, tripId: string) {
  return api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "start" });
}

/** Mark a stop arrived — RAW response (for the arrived-guard tests). */
export function arriveRaw(driverToken: string, tripId: string, stopId: string) {
  return api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "arrived", stop_id: stopId });
}

/** Mark a stop delivered — RAW response (POD must already be satisfied). */
export function deliverRaw(driverToken: string, tripId: string, stopId: string) {
  return api()
    .patch(`/api/v1/trips/${tripId}/status`)
    .set(auth(driverToken))
    .send({ action: "delivered", stop_id: stopId });
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
 * Delivering the LAST stop PROPOSES the incentive and moves the trip to
 * `pending_approval` (POD-approval gate, 16 Jul 2026) — the incentive is
 * computed and frozen in `incentive_earned` but NOT yet payable. Use
 * `approveIncentive` (or `arriveDeliverApprove`) to reach `completed`.
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

/** Admin approves a pending_approval trip's incentive — RAW response. Omit
 *  body to confirm the proposal as-is; pass {final_amount, reason} to edit. */
export function approveIncentiveRaw(
  adminToken: string,
  tripId: string,
  body: { final_amount?: number; reason?: string } = {}
) {
  return api()
    .patch(`/api/v1/trips/${tripId}/approve-incentive`)
    .set(auth(adminToken))
    .send(body);
}

/** Approve a pending_approval trip → completed (throws on non-200). */
export async function approveIncentive(
  adminToken: string,
  tripId: string,
  body: { final_amount?: number; reason?: string } = {}
): Promise<FlowTrip> {
  const res = await approveIncentiveRaw(adminToken, tripId, body);
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${res.text}`);
  return res.body;
}

/** Deliver the last stop AND approve it → the trip reaches `completed` with the
 *  proposal paid as `incentive_final`. Restores the pre-gate one-call "delivery
 *  finalizes" behaviour for tests that only care about the terminal paid state. */
export async function arriveDeliverApprove(
  driverToken: string,
  adminToken: string,
  tripId: string,
  stopId: string
): Promise<FlowTrip> {
  await arriveAndDeliver(driverToken, tripId, stopId);
  return approveIncentive(adminToken, tripId);
}

/** Sorted stops (by sequence) — the create response order isn't guaranteed. */
export function stopsBySequence(trip: FlowTrip): FlowStop[] {
  return [...trip.stops].sort((a, b) => a.sequence - b.sequence);
}

/** N pallets as a single 4×4 cargo line (1 factor each). */
export const pallets = (n: number): CargoLine[] => [{ pallet_type: "4×4", quantity: n }];

export const num = (v: unknown): number => Number(v);

// Seeded driver accounts (phone → truck), for dispatch tests.
export const DRIVERS = {
  PLX: { phone: "+60100000101", plate: "PLX 2406", maxPallets: 16 },
  PND: { phone: "+60100000102", plate: "PND 1888", maxPallets: 14 },
  PRH: { phone: "+60100000106", plate: "PRH 5292", maxPallets: 2 },
} as const;
