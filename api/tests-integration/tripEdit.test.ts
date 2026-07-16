import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import bcrypt from "bcrypt";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import {
  autoDispatch,
  bookTrip,
  ensureConsigneeInZone,
  firstRouteTypeId,
  futurePickupIso,
} from "./helpers/flow";

/**
 * BOOKING EDIT (requestor, pending-only): the full guard ladder and the
 * dispatch interaction. The one branch not exercised here is the in-transaction
 * CAS 409 (status flips between the route's pre-read and its transaction) —
 * that window can't be hit deterministically over HTTP; it is the same
 * status-guarded updateMany shape as cancel, covered by tripExitGuards.test.ts.
 */

const OTHER = { phone: "+60188880002", password: "OtherReq123" };

const editTrip = (token: string, tripId: string, body: unknown) =>
  api().patch(`/api/v1/trips/${tripId}`).set(auth(token)).send(body);

/** The create payload that reproduces bookTrip()'s single-P1-stop booking. */
async function identicalPayload(trip: { stops: { consignee_id: string; sequence: number }[] }, rt: string) {
  return {
    route_type_id: rt,
    pickup_datetime: futurePickupIso(),
    stops: trip.stops.map((s) => ({ consignee_id: s.consignee_id, sequence: s.sequence })),
    cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
  };
}

async function auditRows(tripId: string, action: string) {
  return prisma.auditLog.findMany({ where: { record_id: tripId, action } });
}
async function editedEvents(tripId: string) {
  return prisma.tripStatusHistory.findMany({
    where: { trip_id: tripId, event: "edited" },
    orderBy: { created_at: "asc" },
  });
}

describe("booking edit — PATCH /trips/:id", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    // A test may flip dispatch to auto; never leak that into other files.
    await prisma.appSetting.upsert({
      where: { id: "singleton" },
      update: { dispatch_mode: "manual" },
      create: { id: "singleton", dispatch_mode: "manual" },
    });
  });
  afterAll(async () => {
    const u = await prisma.user.findUnique({ where: { phone: OTHER.phone } });
    if (u) await prisma.user.delete({ where: { id: u.id } });
    await prisma.$disconnect();
  });

  it("owner edits consignee + cargo on a pending booking → 200, replaced, audited, timeline event", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);
    const requestorId = trip.requestor_id as string;

    const newConsignee = await ensureConsigneeInZone("P2");
    const res = await editTrip(requestor, trip.id, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: newConsignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 2, remark: "corrected" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.stops).toHaveLength(1);
    expect(res.body.stops[0].consignee_id).toBe(newConsignee.id);
    expect(res.body.cargo_details[0].quantity).toBe(2);

    const stops = await prisma.tripStop.findMany({ where: { trip_id: trip.id } });
    expect(stops).toHaveLength(1);
    expect(stops[0].consignee_id).toBe(newConsignee.id);
    const cargo = await prisma.cargoDetail.findMany({ where: { trip_id: trip.id } });
    expect(cargo).toHaveLength(1);
    expect(cargo[0].quantity).toBe(2);
    expect(cargo[0].remark).toBe("corrected");

    const audits = await auditRows(trip.id, "trip.updated");
    expect(audits).toHaveLength(1);
    expect(audits[0].user_id).toBe(requestorId);
    const events = await editedEvents(trip.id);
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe(requestorId);
    expect(events[0].note).toBe("consignees; cargo");
  });

  it("locked fields in the body are stripped, never applied", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const res = await editTrip(requestor, trip.id, {
      ...(await identicalPayload(trip, rt)),
      cargo_details: [{ pallet_type: "4×4", quantity: 3 }],
      is_external: true,
      status: "assigned",
      driver_id: "someone",
      truck_plate: "PLX 2406",
      ticket_number: "TKT-FORGED-001",
      incentive_earned: 999,
    });
    expect(res.status).toBe(200);

    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.is_external).toBe(false);
    expect(after.status).toBe("pending");
    expect(after.driver_id).toBeNull();
    expect(after.truck_plate).toBeNull();
    expect(after.ticket_number).toBe(trip.ticket_number);
    expect(after.incentive_earned).toBeNull();
  });

  it("a different requestor cannot edit it → 403; admin is not a booking editor either → 403", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);
    const payload = await identicalPayload(trip, rt);

    const password_hash = await bcrypt.hash(OTHER.password, 10);
    await prisma.user.upsert({
      where: { phone: OTHER.phone },
      update: { password_hash, role: "requestor", status: "active" },
      create: { phone: OTHER.phone, password_hash, name: "Other Requestor", role: "requestor", status: "active" },
    });
    const other = await loginAs(OTHER);
    const stranger = await editTrip(other, trip.id, payload);
    expect(stranger.status).toBe(403);
    expect(stranger.body.error.code).toBe("FORBIDDEN");

    const admin = await loginAs(ADMIN);
    const asAdmin = await editTrip(admin, trip.id, payload);
    expect(asAdmin.status).toBe(403);

    expect(await auditRows(trip.id, "trip.updated")).toHaveLength(0);
  });

  it("an assigned booking is immutable to the requestor → 400 INVALID_STATUS", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);
    expect((await autoDispatch(admin, trip.id)).status).toBe(200);

    const res = await editTrip(requestor, trip.id, await identicalPayload(trip, rt));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
    expect(await editedEvents(trip.id)).toHaveLength(0);
  });

  it("a no-op resubmit writes nothing — no audit row, no timeline event", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const res = await editTrip(requestor, trip.id, await identicalPayload(trip, rt));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(await auditRows(trip.id, "trip.updated")).toHaveLength(0);
    expect(await editedEvents(trip.id)).toHaveLength(0);
  });

  it("an UNCHANGED pickup that has drifted into the past does not block editing other fields", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);

    // Simulate time passing: the booking's pickup is now an hour ago.
    const stalePickup = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.trip.update({ where: { id: trip.id }, data: { pickup_datetime: stalePickup } });

    const res = await editTrip(requestor, trip.id, {
      ...(await identicalPayload(trip, rt)),
      pickup_datetime: stalePickup.toISOString(), // untouched
      cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
    });
    expect(res.status).toBe(200);
    expect((await editedEvents(trip.id))[0].note).toBe("cargo");

    // But CHANGING the pickup to a (different) past time is still rejected.
    const worse = await editTrip(requestor, trip.id, {
      ...(await identicalPayload(trip, rt)),
      pickup_datetime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(worse.status).toBe(400);
    expect(worse.body.error.code).toBe("PICKUP_IN_PAST");
  });

  it("edit re-runs the create-time checks: oversized cargo and inactive consignees are rejected", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);
    const payload = await identicalPayload(trip, rt);

    const oversized = await editTrip(requestor, trip.id, {
      ...payload,
      cargo_details: [{ pallet_type: "4×4", quantity: 17 }],
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe("CARGO_EXCEEDS_FLEET");

    const retired = await prisma.consignee.create({
      data: { company_name: "Deactivated Co", zone_code: "P1", is_active: false },
    });
    const inactive = await editTrip(requestor, trip.id, {
      ...payload,
      stops: [{ consignee_id: retired.id }],
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.code).toBe("CONSIGNEE_NOT_FOUND");

    // Failed validations must leave the booking untouched.
    const stops = await prisma.tripStop.findMany({ where: { trip_id: trip.id } });
    expect(stops.map((s) => s.consignee_id)).toEqual(trip.stops.map((s) => s.consignee_id));
    await prisma.consignee.delete({ where: { id: retired.id } });
  });

  it("AUTO mode: an edit that fixes the dispatch blocker re-triggers dispatch immediately — even after the sweep has given up on the booking", async () => {
    await prisma.appSetting.upsert({
      where: { id: "singleton" },
      update: { dispatch_mode: "auto" },
      create: { id: "singleton", dispatch_mode: "auto" },
    });
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    // Unsized carton cargo → create-time auto-dispatch flags it for manual
    // assignment and leaves it pending.
    const trip = await bookTrip(requestor, ["P1"], rt, [{ pallet_type: "carton", quantity: 1 }]);
    const flagged = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(flagged.status).toBe("pending");
    expect(flagged.auto_dispatch_failed).toBe(true);

    // Simulate the 10-minute alert having fired: the minute-sweep only retries
    // pending_alert_sent=false bookings, so from here NOTHING re-evaluates this
    // trip automatically — the edit itself must.
    await prisma.trip.update({ where: { id: trip.id }, data: { pending_alert_sent: true } });

    const res = await editTrip(requestor, trip.id, {
      ...(await identicalPayload(trip, rt)),
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("assigned");
    expect(res.body.driver_id).not.toBeNull();
    expect(res.body.truck_plate).not.toBeNull();

    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.status).toBe("assigned");
    expect(after.auto_dispatch_failed).toBe(false);
    expect(after.auto_dispatch_note).toBeNull();
  });

  it("MANUAL mode: an edit never assigns — the booking stays pending for the admin", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const res = await editTrip(requestor, trip.id, {
      ...(await identicalPayload(trip, rt)),
      cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.driver_id).toBeNull();
  });
});
