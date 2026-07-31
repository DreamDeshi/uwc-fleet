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
  DRIVERS,
} from "./helpers/flow";

/**
 * GET /incentives/mine IS NOW BOUNDED — AND NOTHING THE DRIVER SEES MAY MOVE.
 *
 * It used to read every trip the driver had ever done, with stops, exceptions
 * and cargo, on every open of the Earnings tab. Bounding a MONEY read is only
 * safe if the window is a strict superset of everything computed from it, so
 * that is what these assert:
 *
 *   the month summary   unchanged, including for a MONTH-CROSSING trip — the
 *                       bound keys on the pay instant, not pickup
 *   awaiting approval   a pending_approval trip of ANY age is still returned
 *   the trip list       only genuinely old COMPLETED trips fall out, and their
 *                       falling out changes no displayed figure
 */
const MYT = 8 * 3600_000;
function currentMytMonthStart(now = new Date()): Date {
  const myt = new Date(now.getTime() + MYT);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - MYT);
}
/** Start of the window itself: the MYT month 5 back (EARNINGS_WINDOW_MONTHS - 1). */
function windowStart(): Date {
  const myt = new Date(Date.now() + MYT);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth() - 5, 1) - MYT);
}
/** Start of the MYT month `n` months before the current one. */
function monthsBack(n: number): Date {
  const myt = new Date(Date.now() + MYT);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth() - n, 1) - MYT);
}

describe("GET /incentives/mine — the six-month window", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";
  const monthStart = currentMytMonthStart();

  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  const mine = async () => {
    const res = await api().get("/api/v1/incentives/mine").set(auth(driver));
    expect(res.status, res.text).toBe(200);
    return res.body as {
      summary: { month: string; total: number; trip_count: number };
      trips: { id: string; pending: boolean; incentive_earned: number }[];
    };
  };

  /**
   * A delivered+approved trip, back-dated to `pickupAt` / `deliveredAt`.
   *
   * The APPROVAL instant is back-dated too, and that is not a detail: a
   * genuinely old trip was settled long ago, and the window has a branch keyed
   * on settlement so a just-paid trip cannot vanish on the day it is paid.
   * Leaving `incentive_approved_at` at "now" would make every fixture look like
   * a trip approved today, and the age tests below would silently stop testing
   * age. Pass `approvedAt` to model a trip settled at a different time from
   * when it ran.
   */
  async function completedTripAt(pickupAt: Date, deliveredAt: Date, approvedAt: Date = deliveredAt) {
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    await approveIncentive(admin, t.id);
    await prisma.trip.update({
      where: { id: t.id },
      data: { pickup_datetime: pickupAt, incentive_approved_at: approvedAt },
    });
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { delivered_at: deliveredAt } });
    return t;
  }

  it("the window is not the CURRENT MONTH — a month-crossing trip counts in full", async () => {
    // Guards against narrowing the window to the current month. It does NOT
    // prove the month-crossing property on its own: both dates here sit inside
    // the six-month window, so it passes under a pickup-only bound too. The
    // edge case is the next test.
    const t = await completedTripAt(
      new Date(monthStart.getTime() - 6 * 3600_000), // previous month, evening
      new Date(monthStart.getTime() + 12 * 3600_000) // this month, noon
    );

    const body = await mine();
    expect(body.trips.map((x) => x.id)).toContain(t.id);
    expect(body.summary.trip_count).toBe(1);
    expect(body.summary.total).toBeGreaterThan(0);
  });

  it("AT THE WINDOW EDGE, a trip is kept by what it EARNED, not when it was picked up", async () => {
    // The property `earnedInWindow` is actually load-bearing for. Picked up the
    // evening BEFORE the window opens, delivered the morning after — so it
    // earned inside the window and belongs in the list. A bound on
    // pickup_datetime alone drops it.
    //
    // Scope, stated honestly: at the EDGE this changes list membership, not a
    // displayed total. The summary is this month and the chart is this week,
    // both far inside a six-month window, so no figure on the screen can move
    // either way. The reason to key on the pay instant anyway is that "which
    // trips did I earn in this period" is the question the endpoint answers,
    // and pickup is not that question — the payroll sheet learned it the
    // expensive way (thisMonthAgreement).
    const edge = windowStart();
    const t = await completedTripAt(
      new Date(edge.getTime() - 6 * 3600_000),
      new Date(edge.getTime() + 12 * 3600_000)
    );

    const body = await mine();
    expect(
      body.trips.map((x) => x.id),
      "a trip that EARNED inside the window was dropped because its pickup fell outside"
    ).toContain(t.id);
  });

  it("the LEGACY ANOMALY — a delivered stop with no delivered_at — still counts", async () => {
    // The ONLY thing keeping the `pickup_datetime` branch honest. A stop marked
    // `delivered` with a NULL delivered_at is real (/reports/attention surfaces
    // it): firstEarningInstant returns null, no stop matches earnedInWindow,
    // and the month bucket falls back to pickup — the same fallback the summary
    // uses. Without that branch the trip leaves the driver's month total while
    // the clerk's payroll sheet still pays it.
    //
    // Found by the money review: deleting the branch left 25 tests green.
    const t = await completedTripAt(
      new Date(monthStart.getTime() + 3 * 3600_000),
      new Date(monthStart.getTime() + 9 * 3600_000)
    );
    await prisma.tripStop.update({
      where: { id: t.stops[0].id },
      data: { delivered_at: null }, // status stays `delivered` — that is the anomaly
    });
    // AND grandfathered: completed before the 16 Jul POD-approval gate, so it
    // has no approval instant either. That is the population the anomaly
    // actually lives in, and it leaves `pickup_datetime` as the ONLY branch
    // that can find this trip — which is what makes this test isolate it.
    await prisma.trip.update({ where: { id: t.id }, data: { incentive_approved_at: null } });

    const body = await mine();
    expect(body.trips.map((x) => x.id), "the anomaly trip fell out of the window").toContain(t.id);
    expect(body.summary.trip_count, "RM left the driver's month total").toBe(1);
    expect(body.summary.total).toBeGreaterThan(0);
  });

  it("a settlement does not vanish on the day it happens", async () => {
    // An aged proposal is exempt from the window while PENDING. Approve it and
    // it becomes `completed`, whose window keys on the pay instant — which is
    // still eight months back. So the row the driver was chasing would be
    // erased at the exact moment it was paid, never once shown as settled.
    // Raised by the money review as needs-confirmation; ruled here by keying a
    // third branch on the APPROVAL instant.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    const old = monthsBack(8);
    await prisma.trip.update({ where: { id: t.id }, data: { pickup_datetime: old } });
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { delivered_at: old } });

    const before = await mine();
    expect(before.trips.find((x) => x.id === t.id)?.pending).toBe(true);

    await approveIncentive(admin, t.id);

    const after = await mine();
    const row = after.trips.find((x) => x.id === t.id);
    expect(row, "the trip disappeared on the day it was settled").toBeTruthy();
    expect(row!.pending).toBe(false); // and now reads as paid, not awaiting
  });

  it("an OLD unapproved trip never ages out — that is money still owed", async () => {
    // pending_approval has no window at all. A proposal the office has sat on
    // for eight months is exactly the one the driver is chasing.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);
    const old = monthsBack(8);
    await prisma.trip.update({ where: { id: t.id }, data: { pickup_datetime: old } });
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { delivered_at: old } });

    const body = await mine();
    const row = body.trips.find((x) => x.id === t.id);
    expect(row, "an old awaiting-approval trip vanished from the driver's screen").toBeTruthy();
    expect(row!.pending).toBe(true);
    expect(Number(row!.incentive_earned)).toBeGreaterThan(0);
    // ...and it is still not counted as paid.
    expect(body.summary.total).toBe(0);
  });

  it("a COMPLETED trip older than the window drops out of the list", async () => {
    const old = monthsBack(9);
    const t = await completedTripAt(old, old);

    const body = await mine();
    expect(body.trips.map((x) => x.id)).not.toContain(t.id);
  });

  it("...and dropping it changes no figure the screen shows", async () => {
    // The safety property. An out-of-window trip contributes to nothing
    // displayed: the summary is this month, the chart is this week.
    const old = monthsBack(9);
    await completedTripAt(old, old);
    const withOld = await mine();

    const t = await completedTripAt(
      new Date(monthStart.getTime() + 3 * 3600_000),
      new Date(monthStart.getTime() + 9 * 3600_000)
    );
    const both = await mine();

    expect(withOld.summary.total).toBe(0);
    expect(withOld.summary.trip_count).toBe(0);
    expect(both.summary.trip_count).toBe(1);
    expect(both.trips.map((x) => x.id)).toEqual([t.id]);
  });

  it("recent completed trips are all still there", async () => {
    // The bound must not be so tight it eats ordinary history.
    const a = await completedTripAt(monthsBack(1), monthsBack(1));
    const b = await completedTripAt(monthsBack(3), monthsBack(3));
    const c = await completedTripAt(monthsBack(5), monthsBack(5));

    const ids = (await mine()).trips.map((x) => x.id);
    for (const [label, id] of [["1 month", a.id], ["3 months", b.id], ["5 months", c.id]] as const) {
      expect(ids, `${label} back fell outside the window`).toContain(id);
    }
  });
});
