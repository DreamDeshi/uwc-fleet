import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
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
 * ARRIVED-GUARD (Phase 4, priority — the audit's total-coverage gap).
 *
 * The `arrived` action guards:
 *   1. stop.status !== "pending"  → 400 INVALID_STATUS   (checked FIRST)
 *   2. trip.status !== "in_progress" → 400 TRIP_NOT_STARTED (checked SECOND)
 *
 * The ORDERING is load-bearing for the mobile offline outbox: it treats
 * INVALID_STATUS on the arrived step as "already done → proceed"
 * (ARRIVED_STEP_ALREADY_CODES). If a non-pending stop on a no-longer-in_progress
 * trip returned TRIP_NOT_STARTED instead, the outbox would treat a completed
 * step as a hard failure and get stuck. This suite pins BOTH the guard and that
 * ordering.
 *
 * (The once-flagged follow-up landed: the route now calls the pure
 * `assertStopArrivable(trip, stop)` in services/tripCompletion.ts — same
 * checks, same order — so the ordering is ALSO unit-tested without a DB
 * (tests/tripCompletion.test.ts). This suite remains the end-to-end pin that
 * the real HTTP route behaves identically.)
 */

const PLX_PLATE = DRIVERS.PLX.plate;

async function setup() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  const rt = await firstRouteTypeId(requestor);
  const plx = await userIdByPhone(DRIVERS.PLX.phone);
  return { requestor, admin, driver, rt, plx };
}

describe("ARRIVED-GUARD integration", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("arrived on a NOT-STARTED (assigned) trip → 400 TRIP_NOT_STARTED", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX_PLATE); // assigned, NOT started

    const res = await arriveRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TRIP_NOT_STARTED");
  });

  it("arrived on an in_progress trip with a pending stop → 200 (happy path)", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX_PLATE);
    await startTrip(driver, trip.id);

    const res = await arriveRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(200);
    const stop = (await prisma.tripStop.findUnique({ where: { id: trip.stops[0].id } }))!;
    expect(stop.status).toBe("arrived");
  });

  it("arrived on an already-arrived stop → 400 INVALID_STATUS", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX_PLATE);
    await startTrip(driver, trip.id);
    expect((await arriveRaw(driver, trip.id, trip.stops[0].id)).status).toBe(200);

    const again = await arriveRaw(driver, trip.id, trip.stops[0].id);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_STATUS");
  });

  it("ORDERING: a non-pending stop on a NO-LONGER-in_progress trip → INVALID_STATUS, not TRIP_NOT_STARTED", async () => {
    // The outbox-critical case. Drive a trip until its last stop is delivered
    // (stop is 'delivered', trip is 'pending_approval' under the POD-approval
    // gate — so BOTH guards would fire), then re-issue `arrived`. The
    // stop-status check must win → INVALID_STATUS.
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX_PLATE);
    await startTrip(driver, trip.id);
    await arriveAndDeliver(driver, trip.id, trip.stops[0].id); // → pending_approval

    const completed = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(completed.status).toBe("pending_approval"); // trip is NOT in_progress…

    const res = await arriveRaw(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(400);
    // …yet the stop-status guard fires first, exactly as the offline outbox needs.
    expect(res.body.error.code).toBe("INVALID_STATUS");
    expect(res.body.error.code).not.toBe("TRIP_NOT_STARTED");
  });
});
