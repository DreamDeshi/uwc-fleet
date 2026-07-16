import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  userIdByPhone,
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  approveIncentiveRaw,
  approveIncentive,
  num,
} from "./helpers/flow";

/**
 * POD INCENTIVE-APPROVAL GATE (Mr. Teh, 16 Jul 2026 — TEST QUERY item 9),
 * end-to-end through Postgres. MONEY PATH — exhaustive.
 *
 * The rule under test: delivering the last stop no longer pays the driver. It
 * PROPOSES the incentive (frozen `incentive_earned`, trip → pending_approval)
 * and holds the money until an admin approves the POD — optionally EDITING the
 * final amount (edit requires a reason; the proposal is preserved). Only the
 * APPROVED `incentive_final` is payable, and only `completed` trips reach
 * payroll. Grandfathering (pre-gate trips paid at `incentive_earned`) is
 * covered by the tripCompletion unit tests.
 *
 * PLX 2406: weekday RM11 / off-peak RM13, daily deduction 2, A-zone truck.
 * A2 (Ipoh) = 6 points → first drop pays (6−2)×rate.
 */

const PLX_PLATE = "PLX 2406";

async function loginAll() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  return { requestor, admin, driver };
}

/** Book A2 → approve+assign to PLX → start → deliver. Leaves the trip in
 *  pending_approval with its incentive proposed. Returns the trip + proposal. */
async function deliverToPending(requestor: string, admin: string, driver: string, driverId: string, rt: string) {
  const t = await bookTrip(requestor, ["A2"], rt);
  await approveTrip(admin, t.id, driverId, PLX_PLATE);
  await startTrip(driver, t.id);
  await arriveAndDeliver(driver, t.id, t.stops[0].id);
  const trip = (await prisma.trip.findUnique({ where: { id: t.id }, include: { stops: true } }))!;
  return trip;
}

async function payrollTotalFor(adminToken: string, driverId: string): Promise<number> {
  const res = await api().get(`/api/v1/reports/payroll`).set(auth(adminToken));
  expect(res.status).toBe(200);
  const rows = res.body.drivers as Array<{ driver_id: string; total: number }>;
  const row = rows.find((r) => r.driver_id === driverId);
  return row ? num(row.total) : 0;
}

describe("POD approval gate — propose → approve, through Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("delivery PROPOSES but does not pay: pending_approval, no incentive_final, not in payroll", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const trip = await deliverToPending(requestor, admin, driver, driverId, rt);
    const rate = num(trip.rate_used);

    expect(trip.status).toBe("pending_approval");
    expect(num(trip.incentive_earned)).toBeCloseTo((6 - 2) * rate, 2); // proposal frozen
    expect(trip.incentive_final).toBeNull(); // not payable yet
    expect(trip.incentive_approved_at).toBeNull();

    // Money is held: payroll (completed-only) shows nothing for this driver.
    expect(await payrollTotalFor(admin, driverId)).toBe(0);

    // The driver sees the trip as PENDING (not counted toward the month total).
    const mine = await api().get(`/api/v1/incentives/mine`).set(auth(driver));
    expect(mine.status).toBe(200);
    expect(mine.body.summary.total).toBe(0); // nothing paid yet
    const line = (mine.body.trips as Array<{ id: string; pending: boolean }>).find((x) => x.id === trip.id);
    expect(line?.pending).toBe(true);
  });

  it("approve WITHOUT edit pays the proposal exactly → completed, in payroll, driver's month total", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    const rate = num(proposed.rate_used);
    const expected = (6 - 2) * rate;

    const res = await approveIncentiveRaw(admin, proposed.id);
    expect(res.status).toBe(200);

    const done = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(done.status).toBe("completed");
    expect(num(done.incentive_final)).toBeCloseTo(expected, 2); // approved == proposal
    expect(num(done.incentive_earned)).toBeCloseTo(expected, 2); // proposal preserved
    expect(done.incentive_override_reason).toBeNull(); // not an edit
    expect(done.incentive_approved_by).toBe(await userIdByPhone(ADMIN.phone));
    expect(done.incentive_approved_at).not.toBeNull();

    // Now it's payable everywhere.
    expect(await payrollTotalFor(admin, driverId)).toBeCloseTo(expected, 2);
    const mine = await api().get(`/api/v1/incentives/mine`).set(auth(driver));
    expect(mine.body.summary.total).toBeCloseTo(expected, 2);
    const line = (mine.body.trips as Array<{ id: string; pending: boolean }>).find((x) => x.id === proposed.id);
    expect(line?.pending).toBe(false);
  });

  it("approve WITH an edit + reason pays the edited amount; payroll & driver reflect it, proposal preserved", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    const original = num(proposed.incentive_earned);
    const edited = original + 10; // admin bumps the rate

    const res = await approveIncentiveRaw(admin, proposed.id, { final_amount: edited, reason: "extra pallet on the DO" });
    expect(res.status).toBe(200);

    const done = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(done.status).toBe("completed");
    expect(num(done.incentive_final)).toBeCloseTo(edited, 2); // payroll pays this
    expect(num(done.incentive_earned)).toBeCloseTo(original, 2); // proposal preserved for the audit trail
    expect(done.incentive_override_reason).toBe("extra pallet on the DO");

    // Payroll pays the EDITED amount, not the proposal.
    expect(await payrollTotalFor(admin, driverId)).toBeCloseTo(edited, 2);
    const mine = await api().get(`/api/v1/incentives/mine`).set(auth(driver));
    expect(mine.body.summary.total).toBeCloseTo(edited, 2);
  });

  it("editing the amount WITHOUT a reason is refused → 400 REASON_REQUIRED, trip stays pending_approval", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    const res = await approveIncentiveRaw(admin, proposed.id, { final_amount: num(proposed.incentive_earned) + 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REASON_REQUIRED");

    const after = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(after.status).toBe("pending_approval"); // unchanged
    expect(after.incentive_final).toBeNull();
  });

  it("a negative final amount is refused → 400 (schema rejects it before it can pay)", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    // z.number().min(0) rejects this as VALIDATION_ERROR before the service
    // guard runs; the service's own INVALID_AMOUNT is the belt-and-braces
    // fallback (unit-tested in tripCompletion.test.ts). Either way: 400, unpaid.
    const res = await approveIncentiveRaw(admin, proposed.id, { final_amount: -1, reason: "x" });
    expect(res.status).toBe(400);
    const after = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(after.status).toBe("pending_approval");
    expect(after.incentive_final).toBeNull();
  });

  it("a trip that is not pending_approval cannot be approved → 409 TRIP_NOT_PENDING_APPROVAL", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    // Started but not delivered → still in_progress.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, PLX_PLATE);
    await startTrip(driver, t.id);

    const res = await approveIncentiveRaw(admin, t.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TRIP_NOT_PENDING_APPROVAL");
  });

  it("a second approval loses → 409, and the first approval's amount stands", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    await approveIncentive(admin, proposed.id); // first: confirm the proposal

    const second = await approveIncentiveRaw(admin, proposed.id, { final_amount: 999, reason: "late edit" });
    expect(second.status).toBe(409);

    const done = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(num(done.incentive_final)).toBeCloseTo(num(proposed.incentive_earned), 2); // first stands
    expect(num(done.incentive_final)).not.toBe(999);
  });

  it("a driver cannot approve their own incentive → 403", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const proposed = await deliverToPending(requestor, admin, driver, driverId, rt);
    const res = await approveIncentiveRaw(driver, proposed.id);
    expect(res.status).toBe(403);

    const after = (await prisma.trip.findUnique({ where: { id: proposed.id } }))!;
    expect(after.status).toBe("pending_approval"); // untouched
  });
});
