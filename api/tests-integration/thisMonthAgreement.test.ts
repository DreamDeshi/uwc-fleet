import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  bookTrip,
  approveTrip,
  startTrip,
  arriveDeliverApprove,
  firstRouteTypeId,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";

/**
 * EVERY "THIS MONTH" MONEY FIGURE MUST AGREE ABOUT THE SAME TRIP.
 *
 * Four admin surfaces answer "what did this driver earn this month", each with
 * its own query:
 *
 *   GET /reports/payroll?month=   the clerk's sheet — what actually gets paid
 *   GET /reports/monthly          the 6-month summary, and the THIRD SECTION OF
 *                                 THE PAYROLL CSV, so a disagreement puts two
 *                                 different numbers in one file
 *   GET /users/drivers/performance   pointsThisMonth, which ranks drivers
 *   GET /reports/drivers          the drivers report
 *
 * Three of those four had NO integration cover at all. They are written to
 * agree — all key on payAttributionInstant and payableIncentive, and
 * users.ts:94 and reports.ts:232 both carry comments promising it — but a
 * promise in a comment is what failed last time: points_awarded was added to
 * the pay predicate and threaded into some paths and not others, and the
 * surfaces silently drifted apart.
 *
 * The trip below CROSSES a month boundary, because that is the only shape where
 * the surfaces can disagree while every individual number still looks
 * plausible. Anchored on the REAL current MYT month, since
 * /users/drivers/performance has no month selector — it always means "now".
 */

/** Start of the current MYT month, as the UTC instant it is. */
function currentMytMonthStart(now = new Date()): Date {
  const myt = new Date(now.getTime() + 8 * 3600_000);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - 8 * 3600_000);
}
const monthKeyOf = (d: Date): string => {
  const myt = new Date(d.getTime() + 8 * 3600_000);
  return `${myt.getUTCFullYear()}-${String(myt.getUTCMonth() + 1).padStart(2, "0")}`;
};

describe("all 'this month' money surfaces agree about a month-crossing trip", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";
  const monthStart = currentMytMonthStart();
  const THIS_MONTH = monthKeyOf(monthStart);
  const PREV_MONTH = monthKeyOf(new Date(monthStart.getTime() - 24 * 3600_000));
  // Delivered on day 1 of this month at noon MYT; picked up six hours earlier,
  // which is the evening of the LAST day of the previous month.
  const DELIVERED_AT = new Date(monthStart.getTime() + 12 * 3600_000);
  const PICKED_UP_AT = new Date(monthStart.getTime() - 6 * 3600_000);

  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await resetDb();
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveDeliverApprove(driver, admin, t.id, t.stops[0].id);
    await prisma.trip.update({ where: { id: t.id }, data: { pickup_datetime: PICKED_UP_AT } });
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { delivered_at: DELIVERED_AT } });
  });

  const get = async (path: string) => {
    const res = await api().get(`/api/v1${path}`).set(auth(admin));
    expect(res.status, `${path}: ${res.text}`).toBe(200);
    return res.body;
  };

  it("payroll, monthly and driver performance report the SAME ringgit", async () => {
    const payroll = await get(`/reports/payroll?month=${THIS_MONTH}`);
    const payrollTotal = (payroll.drivers as { driver_id: string; total: number }[])
      .find((d) => d.driver_id === driverId)!.total;

    const monthly = (await get("/reports/monthly")) as { month: string; incentive: number }[];
    const monthlyThis = monthly.find((m) => m.month === THIS_MONTH);
    expect(monthlyThis, `/reports/monthly has no bucket for ${THIS_MONTH}`).toBeTruthy();

    // `points_this_month` is RM, not points — it sums payableIncentive. The
    // name is historical; the value is money, which is why it belongs here.
    const performance = (await get("/users/drivers/performance")) as
      { id: string; points_this_month: number }[];
    const me = performance.find((p) => p.id === driverId);
    expect(me, "the driver is missing from /users/drivers/performance").toBeTruthy();
    const points = me!.points_this_month;

    // The trip is real money, or the comparison below is three zeroes agreeing.
    expect(payrollTotal).toBeGreaterThan(0);

    expect(Number(monthlyThis!.incentive.toFixed(2)), "monthly disagrees with payroll").toBe(
      Number(payrollTotal.toFixed(2))
    );
    expect(Number(Number(points).toFixed(2)), "driver performance disagrees with payroll").toBe(
      Number(payrollTotal.toFixed(2))
    );
  });

  it("none of them attribute it to the month it was PICKED UP in", async () => {
    // The pickup is in the previous month. A surface that keys on pickup rather
    // than the pay instant puts the money there — plausible-looking, and wrong
    // by a whole pay period.
    const prevPayroll = await get(`/reports/payroll?month=${PREV_MONTH}`);
    const prevTotal = (prevPayroll.drivers as { driver_id: string; total: number }[])
      .find((d) => d.driver_id === driverId)?.total ?? 0;
    expect(prevTotal).toBe(0);

    const monthly = (await get("/reports/monthly")) as { month: string; incentive: number }[];
    const prev = monthly.find((m) => m.month === PREV_MONTH);
    if (prev) expect(prev.incentive, `${PREV_MONTH} should hold no incentive`).toBe(0);
  });

  it("the drivers report agrees too", async () => {
    // /reports/drivers has partial cover elsewhere; included here because it is
    // the fourth surface answering the same question, and the point of this
    // file is that NONE of them may drift.
    // No escape hatches: an earlier draft did `if (!row) return` and only
    // asserted when the field happened to be defined, which would have passed
    // silently the day either changed. Both are pinned by name instead.
    const drivers = (await get("/reports/drivers")) as
      { id: string; incentive_this_month: number }[];
    const row = drivers.find((d) => d.id === driverId);
    expect(row, "the driver is missing from /reports/drivers").toBeTruthy();

    const payroll = await get(`/reports/payroll?month=${THIS_MONTH}`);
    const payrollTotal = (payroll.drivers as { driver_id: string; total: number }[])
      .find((d) => d.driver_id === driverId)!.total;

    expect(payrollTotal).toBeGreaterThan(0);
    expect(Number(row!.incentive_this_month.toFixed(2)), "the drivers report disagrees with payroll").toBe(
      Number(payrollTotal.toFixed(2))
    );
  });
});
