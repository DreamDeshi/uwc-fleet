import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  approveIncentive,
  firstRouteTypeId,
  userIdByPhone,
  stopsBySequence,
  num,
  DRIVERS,
} from "./helpers/flow";

/**
 * DRIVER "MY STATS" — BOTH SEGMENTS, AND THE CLERK.
 *
 * My Stats is a shell over two screens that each fetch their own endpoint:
 *
 *   Earnings  GET /incentives/mine        summary.total
 *   Score     GET /users/me/performance   rm_earned_this_month
 *
 * Both answer "RM I earned this month", and the driver flips between them with
 * one tap — the tab merge exists *because* they were two tabs showing the same
 * figure. A disagreement is therefore visible to the driver in a single screen,
 * and the number he compares against his payslip is a THIRD query
 * (GET /reports/payroll) he never sees.
 *
 * PR #73 pinned four ADMIN surfaces to agree about this. Neither driver-facing
 * one was in that set, so the person the money belongs to was the only one
 * reading an unpinned number.
 *
 * The trip below CROSSES a month boundary, because that is the only shape where
 * they can disagree while every individual figure still looks plausible.
 */
function currentMytMonthStart(now = new Date()): Date {
  const myt = new Date(now.getTime() + 8 * 3600_000);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - 8 * 3600_000);
}
const monthKeyOf = (d: Date): string => {
  const myt = new Date(d.getTime() + 8 * 3600_000);
  return `${myt.getUTCFullYear()}-${String(myt.getUTCMonth() + 1).padStart(2, "0")}`;
};

describe("driver My Stats agrees with itself and with payroll", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";
  const monthStart = currentMytMonthStart();
  const THIS_MONTH = monthKeyOf(monthStart);
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
  beforeEach(async () => { await resetDb(); });

  const asDriver = async (path: string) => {
    const res = await api().get(`/api/v1${path}`).set(auth(driver));
    expect(res.status, `${path}: ${res.text}`).toBe(200);
    return res.body;
  };

  /** The clerk's figure for this driver, this month. */
  async function payrollTotal(): Promise<number> {
    const res = await api().get(`/api/v1/reports/payroll?month=${THIS_MONTH}`).set(auth(admin));
    expect(res.status, res.text).toBe(200);
    return (res.body.drivers as { driver_id: string; total: number }[])
      .find((d) => d.driver_id === driverId)?.total ?? 0;
  }

  /** A completed, approved A2 trip, back-dated to cross the month boundary. */
  async function monthCrossingTrip() {
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    await approveIncentive(admin, t.id);
    await prisma.trip.update({ where: { id: t.id }, data: { pickup_datetime: PICKED_UP_AT } });
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { delivered_at: DELIVERED_AT } });
    return t;
  }

  it("both segments and the payslip name the same ringgit", async () => {
    await monthCrossingTrip();

    const earnings = await asDriver("/incentives/mine");
    const score = await asDriver("/users/me/performance");
    const clerk = await payrollTotal();

    // Real money, or the comparison below is three zeroes agreeing.
    expect(clerk).toBeGreaterThan(0);
    expect(earnings.summary.month).toBe(THIS_MONTH);

    expect(Number(earnings.summary.total.toFixed(2)), "Earnings disagrees with payroll").toBe(
      Number(clerk.toFixed(2))
    );
    expect(Number(Number(score.rm_earned_this_month).toFixed(2)), "Score disagrees with payroll").toBe(
      Number(clerk.toFixed(2))
    );
  });

  it("neither attributes it to the month it was PICKED UP in", async () => {
    // The pickup is in the previous month. A surface keying on pickup rather
    // than the pay instant puts the money there — plausible, and wrong by a
    // whole pay period.
    await monthCrossingTrip();
    const earnings = await asDriver("/incentives/mine");
    expect(earnings.summary.trip_count).toBe(1);
    expect(Number(earnings.summary.total)).toBeGreaterThan(0);
  });

  it("a trip AWAITING APPROVAL is listed but not counted as earned", async () => {
    // The POD-approval gate: delivered, proposal frozen, not yet payable. The
    // driver must see it — otherwise a delivered trip vanishes — but it must
    // not inflate a total he will compare against his payslip.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } });
    expect(after.status).toBe("pending_approval");

    const earnings = await asDriver("/incentives/mine");
    const row = (earnings.trips as { id: string; pending: boolean; incentive_earned: number }[])
      .find((x) => x.id === t.id);
    expect(row, "the delivered trip is missing from the driver's list").toBeTruthy();
    expect(row!.pending).toBe(true);
    expect(Number(row!.incentive_earned)).toBeGreaterThan(0); // the proposal IS shown

    expect(earnings.summary.total).toBe(0);
    expect(earnings.summary.trip_count).toBe(0);
    expect(Number((await asDriver("/users/me/performance")).rm_earned_this_month)).toBe(0);
    expect(await payrollTotal()).toBe(0);
  });

  it("an ADMIN-EDITED final amount is what the driver is shown, not the proposal", async () => {
    // The one place the two figures can legitimately differ from the engine's
    // output. Both driver surfaces read payableIncentive, so both must move.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    const proposed = num((await prisma.trip.findUniqueOrThrow({ where: { id: t.id } })).incentive_earned);
    expect(proposed).toBeGreaterThan(0);

    const edited = Math.round((proposed + 10) * 100) / 100;
    await approveIncentive(admin, t.id, { final_amount: edited, reason: "goodwill after a late gate" });

    const earnings = await asDriver("/incentives/mine");
    const score = await asDriver("/users/me/performance");
    expect(Number(earnings.summary.total.toFixed(2)), "Earnings still shows the proposal").toBe(edited);
    expect(Number(Number(score.rm_earned_this_month).toFixed(2)), "Score still shows the proposal").toBe(edited);
    expect(Number((await payrollTotal()).toFixed(2))).toBe(edited);
  });

  it("a trip ABORTED after one drop is not counted ON TIME", async () => {
    // Reachable with no feature flag. The abort's partial-pay path finalizes
    // with the two unreached stops left `pending`, and approval makes the trip
    // `completed` — so the score sees a completed trip whose stops were never
    // delivered. `delivered_at: null` used to read as "not late", and one drop
    // before a breakdown scored a clean on-time tick.
    const t = await bookTrip(requestor, ["A2", "P1", "P2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    const [first] = stopsBySequence(t);
    await arriveAndDeliver(driver, t.id, first.id);
    const abort = await api()
      .patch(`/api/v1/trips/${t.id}/abort`)
      .set(auth(admin))
      .send({ reason: "lorry breakdown after the first drop" });
    expect(abort.status, abort.text).toBe(200);
    await approveIncentive(admin, t.id);

    const stops = await prisma.tripStop.findMany({ where: { trip_id: t.id }, select: { delivered_at: true } });
    expect(stops.filter((s) => s.delivered_at === null)).toHaveLength(2);

    const score = await asDriver("/users/me/performance");
    // The abort still COUNTS as a completed trip (completion rate is a different
    // question), but it is out of the on-time denominator entirely — nothing to
    // judge, rather than a failure to be punctual.
    expect(score.total_completed).toBe(1);
    expect(score.on_time_rate).toBe(0); // empty denominator
  });

  it("BOTH SURFACES report the same on-time rate for the same two trips", async () => {
    // THE DISAGREEMENT THE 31 JUL RULING SETTLED. One clean run plus one
    // breakdown read 100% on the admin's dashboard and 50% on the driver's own
    // My Stats, because the two computed the denominator differently. A
    // driver-visible score must not depend on which screen you open.
    const clean = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, clean.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, clean.id);
    await arriveAndDeliver(driver, clean.id, clean.stops[0].id);
    await approveIncentive(admin, clean.id);

    const broken = await bookTrip(requestor, ["P1", "P2"], rt);
    await approveTrip(admin, broken.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, broken.id);
    await arriveAndDeliver(driver, broken.id, stopsBySequence(broken)[0].id);
    expect((await api().patch(`/api/v1/trips/${broken.id}/abort`).set(auth(admin))
      .send({ reason: "breakdown" })).status).toBe(200);
    await approveIncentive(admin, broken.id);

    const score = await asDriver("/users/me/performance");
    const dash = await (async () => {
      const res = await api().get("/api/v1/reports/dashboard").set(auth(admin));
      expect(res.status, res.text).toBe(200);
      return res.body;
    })();

    expect(score.total_completed, "both trips reached completed").toBe(2);
    expect(score.on_time_rate, "the clean run is the only judgeable trip").toBe(100);
    expect(dash.on_time_rate, "the dashboard disagrees with the driver's own screen").toBe(
      score.on_time_rate
    );
  });

  it("a fully delivered trip still scores on time", async () => {
    // The regression the change above must not cause.
    const t = await bookTrip(requestor, ["A2", "P1"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    for (const stop of stopsBySequence(t)) await arriveAndDeliver(driver, t.id, stop.id);
    await approveIncentive(admin, t.id);

    const score = await asDriver("/users/me/performance");
    expect(score.total_completed).toBe(1);
    expect(score.on_time_rate).toBe(100);
  });

  it("neither endpoint answers to anyone but the driver", async () => {
    for (const path of ["/incentives/mine", "/users/me/performance"]) {
      for (const [who, token] of [["admin", admin], ["requestor", requestor]] as const) {
        const res = await api().get(`/api/v1${path}`).set(auth(token));
        expect(res.status, `${who} got ${res.status} on ${path}`).toBe(403);
      }
      expect((await api().get(`/api/v1${path}`)).status).toBe(401);
    }
  });

  it("the driver's own earnings never leak another driver's trips", async () => {
    // /incentives/mine scopes on driver_id. A second driver's completed trip
    // must be invisible in both the list and the total.
    const other = await loginAs({ phone: DRIVERS.PSA.phone, password: "Password123" });
    const otherId = await userIdByPhone(DRIVERS.PSA.phone);
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, otherId, DRIVERS.PSA.plate);
    await startTrip(other, t.id);
    await arriveAndDeliver(other, t.id, t.stops[0].id);
    await approveIncentive(admin, t.id);

    const mine = await asDriver("/incentives/mine");
    expect(mine.trips).toHaveLength(0);
    expect(mine.summary.total).toBe(0);
  });
});
