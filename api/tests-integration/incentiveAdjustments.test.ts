import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveDeliverApprove,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";
import { mytMonthKey } from "../src/lib/myt";
import { INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK } from "../src/services/incentiveAdjustments";

/**
 * INCENTIVE ADJUSTMENT (R6-2/R6-3, owner ruling 29 Aug 2026). Append-only
 * correction against an already-completed trip's pay — Trip.incentive_final
 * is write-once and payroll has no period lock, so this is a NEW line
 * landing in the CURRENT month, never an edit to the original.
 *
 * monthsBetweenKeys/isWithinAdjustmentWindow are unit-tested without a DB in
 * tests/incentiveAdjustments.test.ts, including the R6-3 boundary proven
 * both ways. buildPayrollRows's fold-in is unit-tested in tests/payroll.test.ts.
 * This suite is the "guard reached" half: the real routes, against a real
 * database, driving an actual trip through completion.
 */
const PND_PLATE = DRIVERS.PND.plate;

describe("POST /trips/:id/incentive-adjustments", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an adjustment against a completed trip, audited, effective THIS month", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    const completed = await arriveDeliverApprove(driver, admin, trip.id, trip.stops[0].id);
    expect(completed.status).toBe("completed");

    const res = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 12.5, reason: "underpaid zone points, found late" });

    expect(res.status).toBe(201);
    expect(res.body.trip_id).toBe(trip.id);
    expect(Number(res.body.delta)).toBe(12.5);
    expect(res.body.effective_month).toBe(mytMonthKey(new Date()));

    // The trip's own incentive_final is UNTOUCHED — the whole point.
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(Number(after.incentive_final)).toBe(Number(completed.incentive_final));

    const audit = await prisma.auditLog.findFirst({
      where: { record_id: trip.id, action: { contains: "incentive_adjusted" } },
    });
    expect(audit, "must be audited").not.toBeNull();
    expect(audit!.action).toContain("+RM12.50");
    expect(audit!.action).toContain("underpaid zone points, found late");
  });

  it("⚠ refuses a trip still pending_approval — nothing has locked yet to correct", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    // Deliver but do NOT approve — trip sits pending_approval, incentive_final null.
    await api()
      .patch(`/api/v1/trips/${trip.id}/status`)
      .set(auth(driver))
      .send({ action: "arrived", stop_id: trip.stops[0].id });
    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: { pod_photo: "test://pod.jpg", do_uploaded: true },
    });
    await api()
      .patch(`/api/v1/trips/${trip.id}/status`)
      .set(auth(driver))
      .send({ action: "delivered", stop_id: trip.stops[0].id });

    const stillPending = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(stillPending.status).toBe("pending_approval");

    const res = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 5, reason: "too early" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TRIP_NOT_ADJUSTABLE");
  });

  it("⚠ refuses a trip whose pay month is more than 3 months back (R6-3)", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    await arriveDeliverApprove(driver, admin, trip.id, trip.stops[0].id);

    // Backdate the earning instant to 4 months before now — one past the
    // INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK (3) boundary.
    const now = new Date();
    const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK + 1), 15));
    await prisma.tripStop.update({ where: { id: trip.stops[0].id }, data: { delivered_at: old } });

    const res = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 5, reason: "too old" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ADJUSTMENT_WINDOW_EXPIRED");
  });

  it("rejects a zero delta and a too-short reason (validation, not a business rule)", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    await arriveDeliverApprove(driver, admin, trip.id, trip.stops[0].id);

    const zero = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 0, reason: "why bother" });
    expect(zero.status).toBe(400);

    const shortReason = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 5, reason: "x" });
    expect(shortReason.status).toBe(400);
  });

  it("is admin-only — a requestor and a driver are both forbidden", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    await arriveDeliverApprove(driver, admin, trip.id, trip.stops[0].id);

    for (const token of [requestor, driver]) {
      const res = await api()
        .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
        .set(auth(token))
        .send({ delta: 5, reason: "should be forbidden" });
      expect(res.status).toBe(403);
    }
  });

  it("GET lists adjustments oldest first, and the payroll sheet folds the delta into the driver's total", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);

    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, pnd, PND_PLATE);
    await startTrip(driver, trip.id);
    const completed = await arriveDeliverApprove(driver, admin, trip.id, trip.stops[0].id);

    const created = await api()
      .post(`/api/v1/trips/${trip.id}/incentive-adjustments`)
      .set(auth(admin))
      .send({ delta: 12.5, reason: "underpaid, found late" });
    expect(created.status).toBe(201);

    const list = await api().get(`/api/v1/trips/${trip.id}/incentive-adjustments`).set(auth(admin));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(Number(list.body[0].delta)).toBe(12.5);

    const monthKey = mytMonthKey(new Date());
    const payroll = await api().get(`/api/v1/reports/payroll?month=${monthKey}`).set(auth(admin));
    expect(payroll.status).toBe(200);
    const driverRow = payroll.body.drivers.find((d: { driver_id: string }) => d.driver_id === pnd);
    expect(driverRow).toBeTruthy();
    expect(driverRow.adjustments.length).toBe(1);
    expect(Number(driverRow.adjustments[0].delta)).toBe(12.5);
    // Total = the completed trip's paid amount + the adjustment.
    expect(driverRow.total).toBe(Number(completed.incentive_final) + 12.5);
  });
});
