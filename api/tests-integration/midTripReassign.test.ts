import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveRaw,
  arriveAndDeliver,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";

/**
 * MID-TRIP REASSIGNMENT (31 Aug 2026, whole-codebase-review follow-up). The
 * existing /:id/reassign route only ever worked on an `assigned` (not yet
 * started) trip — once `in_progress`, the only lever was `abort`, which
 * terminates the trip rather than handing the remaining stops to someone
 * else.
 *
 * This is a NARROW extension, not the general case: reassignment is only
 * allowed while the trip has ZERO delivered stops. The general case (some
 * stops already delivered under the old driver) hits R6-6, an unanswered
 * client question about whose rate applies to a split, and stays frozen —
 * see releaseInProgressTripWithNoDeliveries's own comment.
 *
 * releaseInProgressTripWithNoDeliveries's CAS logic is unit-tested without a
 * DB in tests/tripReassign.test.ts. This suite is the "guard reached" half:
 * the real PATCH /trips/:id/reassign route, against a real database, driving
 * an actual trip through start/arrive/deliver.
 */
const PND_PLATE = DRIVERS.PND.plate;
const PSA_PLATE = DRIVERS.PSA.plate;

describe("PATCH /trips/:id/reassign — mid-trip (in_progress, zero delivered stops)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reassigns an in_progress trip whose stop is still pending — the driver never arrived", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const psa = await userIdByPhone(DRIVERS.PSA.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);

    const before = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(before.status).toBe("in_progress");

    const res = await api()
      .patch(`/api/v1/trips/${trip.id}/reassign`)
      .set(auth(admin))
      .send({ driver_id: psa, truck_plate: PSA_PLATE, reason: "PND broke down before the first stop" });

    expect(res.status).toBe(200);
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.status).toBe("assigned"); // back through the normal assign ladder
    expect(after.driver_id).toBe(psa);
    expect(after.truck_plate).toBe(PSA_PLATE);

    const audit = await prisma.auditLog.findFirst({
      where: { record_id: trip.id, action: { contains: "mid-trip" } },
    });
    expect(audit, "audit trail must name this as a mid-trip reassignment").not.toBeNull();
  });

  it("reassigns an in_progress trip whose driver ARRIVED but never delivered, and resets the stop", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const psa = await userIdByPhone(DRIVERS.PSA.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    const stopId = trip.stops[0].id;
    expect((await arriveRaw(driver, trip.id, stopId)).status).toBe(200);

    const res = await api()
      .patch(`/api/v1/trips/${trip.id}/reassign`)
      .set(auth(admin))
      .send({ driver_id: psa, truck_plate: PSA_PLATE });
    expect(res.status).toBe(200);

    // The new driver hasn't been anywhere — the OLD driver's arrival must not
    // survive onto the new assignment.
    const stop = await prisma.tripStop.findUnique({ where: { id: stopId } });
    expect(stop!.status).toBe("pending");
    expect(stop!.arrived_at).toBeNull();
  });

  it("⚠ refuses once a stop is delivered — that's the R6-6 boundary, not a bug", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const psa = await userIdByPhone(DRIVERS.PSA.phone);

    // Two stops, so delivering the first leaves the trip in_progress rather
    // than completing it outright.
    const trip = await bookTrip(requestor, ["P1", "A1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    await arriveAndDeliver(driver, trip.id, trip.stops[0].id);

    const midway = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(midway.status).toBe("in_progress"); // one stop left

    const res = await api()
      .patch(`/api/v1/trips/${trip.id}/reassign`)
      .set(auth(admin))
      .send({ driver_id: psa, truck_plate: PSA_PLATE });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MID_TRIP_REASSIGN_HAS_DELIVERIES");

    // Nothing moved — same driver, same truck, first stop's delivery intact.
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.driver_id).toBe(pnd);
    const deliveredStop = await prisma.tripStop.findUnique({ where: { id: trip.stops[0].id } });
    expect(deliveredStop!.status).toBe("delivered");
  });

  it("a plain ASSIGNED (not yet started) trip is unaffected — the existing lever, unchanged", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const psa = await userIdByPhone(DRIVERS.PSA.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);

    const res = await api()
      .patch(`/api/v1/trips/${trip.id}/reassign`)
      .set(auth(admin))
      .send({ driver_id: psa, truck_plate: PSA_PLATE });
    expect(res.status).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { record_id: trip.id, action: { contains: "trip.reassigned" } },
    });
    // The pre-start path must NOT be tagged "mid-trip" — only the new branch is.
    expect(audit!.action).not.toContain("mid-trip");
  });
});
