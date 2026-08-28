import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveRaw,
  deliverRaw,
  undoRaw,
  approveIncentiveRaw,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";

/**
 * STOP-TAP UNDO (mis-tap fix for Arrived/Delivered).
 *
 * assertStopTapUndoable + revertFinalizeForUndo are unit-tested without a DB
 * in tests/tripCompletion.test.ts, including proven-by-breaking coverage of
 * the two money guards (INCENTIVE_ALREADY_APPROVED, the CAS in
 * revertFinalizeForUndo). This suite is the "assert the guard is REACHED"
 * half: it proves the real HTTP route — PATCH
 * /trips/:id/stops/:stopId/undo — actually calls them, end to end, against a
 * real database, for every branch a unit test cannot see (the trip-row lock,
 * the re-read-under-lock, the actual Postgres write).
 */

const PND_PLATE = DRIVERS.PND.plate;

async function setup() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  const rt = await firstRouteTypeId(requestor);
  const plx = await userIdByPhone(DRIVERS.PND.phone);
  return { requestor, admin, driver, rt, plx };
}

describe("STOP-TAP UNDO integration", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("undoes a fresh 'arrived' tap → stop back to pending, arrived_at cleared", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    expect((await arriveRaw(driver, trip.id, trip.stops[0].id)).status).toBe(200);

    const res = await undoRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(200);

    const stop = (await prisma.tripStop.findUnique({ where: { id: trip.stops[0].id } }))!;
    expect(stop.status).toBe("pending");
    expect(stop.arrived_at).toBeNull();

    // The stop is genuinely back to its starting state — arriving again works.
    expect((await arriveRaw(driver, trip.id, trip.stops[0].id)).status).toBe(200);
  });

  it("undoes a 'delivered' tap on a NON-final stop — trip stays in_progress, no money touched", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1", "P2"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    const [first] = trip.stops;
    expect((await arriveRaw(driver, trip.id, first.id)).status).toBe(200);
    await prisma.tripStop.update({ where: { id: first.id }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, trip.id, first.id)).status).toBe(200);

    const midTrip = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(midTrip.status).toBe("in_progress"); // one stop still outstanding
    expect(midTrip.incentive_earned).toBeNull();

    const res = await undoRaw(driver, trip.id, first.id);
    expect(res.status).toBe(200);

    const stop = (await prisma.tripStop.findUnique({ where: { id: first.id } }))!;
    expect(stop.status).toBe("arrived"); // back one step, not all the way to pending
    expect(stop.delivered_at).toBeNull();
    expect(stop.arrived_at).not.toBeNull(); // the real arrival stands

    const trip2 = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(trip2.status).toBe("in_progress");
  });

  it("undoes the FINALIZING 'delivered' tap — trip reopens to in_progress, incentive/evidence cleared, and re-delivering re-finalizes correctly", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt); // single stop → this delivery finalizes
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    const stopId = trip.stops[0].id;
    expect((await arriveRaw(driver, trip.id, stopId)).status).toBe(200);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, trip.id, stopId)).status).toBe(200);

    const finalized = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(finalized.status).toBe("pending_approval");
    expect(finalized.incentive_earned).not.toBeNull();
    const originalProposal = Number(finalized.incentive_earned);

    const res = await undoRaw(driver, trip.id, stopId);
    expect(res.status).toBe(200);

    const reopened = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(reopened.status).toBe("in_progress");
    expect(reopened.incentive_earned).toBeNull();
    expect(reopened.rate_used).toBeNull();
    expect(reopened.deduction_applied).toBeNull();

    const stop = (await prisma.tripStop.findUnique({ where: { id: stopId } }))!;
    expect(stop.status).toBe("arrived");
    expect(stop.delivered_at).toBeNull();
    expect(stop.points_awarded).toBeNull();
    expect(stop.was_repeat).toBeNull();

    // Re-deliver — finalization must re-trigger and reproduce the SAME proposal
    // (nothing else changed in between), proving the undo is genuinely lossless.
    const redelivered = await deliverRaw(driver, trip.id, stopId);
    expect(redelivered.status).toBe(200);
    const refinalized = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(refinalized.status).toBe("pending_approval");
    expect(Number(refinalized.incentive_earned)).toBe(originalProposal);
  });

  it("refuses once the undo window has passed → 409 UNDO_WINDOW_EXPIRED, nothing changes", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    expect((await arriveRaw(driver, trip.id, trip.stops[0].id)).status).toBe(200);

    // Backdate the tap past the window — same effect as time actually passing.
    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: { arrived_at: new Date(Date.now() - 3 * 60 * 1000) },
    });

    const res = await undoRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("UNDO_WINDOW_EXPIRED");

    const stop = (await prisma.tripStop.findUnique({ where: { id: trip.stops[0].id } }))!;
    expect(stop.status).toBe("arrived"); // untouched
  });

  it("refuses once the incentive has been approved (trip is completed) → 409, money untouched", async () => {
    // In the real approval flow, approving ALWAYS flips status to "completed"
    // in the same write that sets incentive_approved_at (approveTripIncentiveOnce),
    // so the route's TRIP_NOT_ACTIVE check (status no longer in_progress/
    // pending_approval) fires before INCENTIVE_ALREADY_APPROVED ever would.
    // That second code is defence-in-depth for a state this flow can't reach
    // (approved but still pending_approval) — pinned directly in
    // tests/tripCompletion.test.ts. Here we pin the code an admin's browser
    // actually sees, and that undo is refused either way.
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    const stopId = trip.stops[0].id;
    expect((await arriveRaw(driver, trip.id, stopId)).status).toBe(200);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, trip.id, stopId)).status).toBe(200);
    expect((await approveIncentiveRaw(admin, trip.id)).status).toBe(200);

    const approved = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(approved.status).toBe("completed");
    const paidAmount = approved.incentive_final;

    const res = await undoRaw(driver, trip.id, stopId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TRIP_NOT_ACTIVE");

    const untouched = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(untouched.status).toBe("completed");
    expect(untouched.incentive_final).toEqual(paidAmount);
  });

  it("an UNASSIGNED driver cannot undo another driver's tap → 403 FORBIDDEN", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);
    expect((await arriveRaw(driver, trip.id, trip.stops[0].id)).status).toBe(200);

    const otherDriver = await loginAs({ phone: DRIVERS.PSA.phone, password: "Password123" });
    const res = await undoRaw(otherDriver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");

    const stop = (await prisma.tripStop.findUnique({ where: { id: trip.stops[0].id } }))!;
    expect(stop.status).toBe("arrived"); // untouched
  });

  it("a pending stop has nothing to undo → 400 NOTHING_TO_UNDO", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND_PLATE);
    await startTrip(driver, trip.id);

    const res = await undoRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NOTHING_TO_UNDO");
  });
});
