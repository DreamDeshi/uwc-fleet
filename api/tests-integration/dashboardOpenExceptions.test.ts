import crypto from "node:crypto";

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import { bookTrip, firstRouteTypeId } from "./helpers/flow";

/**
 * THE EXCEPTION LANE'S COUNT ON THE ADMIN DASHBOARD.
 *
 * WHY IT IS ON THE DASHBOARD and not left to the push alerts: both exception
 * alerts (at-report and the 30-minute escalation) select admins with
 * `expo_push_token != null`, and push registration returns null on web and on
 * simulators — a token exists only for a native install. A read against
 * PRODUCTION on 12 Aug 2026 found ZERO users of ANY role holding a token, so
 * until an APK is in people's hands the notification channel reaches nobody.
 * `/reports/dashboard` is already polled every 30 seconds by every admin,
 * whatever they are running, which makes this count the workflow's only
 * dependable signal rather than a nicety.
 *
 * ⚠ The closed-exception case is what discriminates. A count of "every
 * exception row" would look right on a fresh database and drift upward forever
 * as reports were resolved — the chip would read 14 with nothing to do. It also
 * pins the OPEN predicate to `closed_at IS NULL` rather than to
 * `Trip.open_exception_id`: since the one-BLOCKING-per-trip relaxation, that
 * pointer means "blocking this trip", so a driver who continued past a report
 * leaves it open but unblocking — and those are precisely the reports nobody
 * has actioned.
 */

async function seedException(opts: { closedAt?: Date | null } = {}) {
  const requestor = await loginAs(REQUESTOR);
  const trip = await bookTrip(requestor, ["A1"], await firstRouteTypeId(requestor));
  const driver = await prisma.user.findFirst({ where: { role: "driver" }, select: { id: true } });
  return prisma.tripException.create({
    data: {
      trip_id: trip.id,
      client_occurrence_id: crypto.randomUUID(),
      category: "truck",
      reason: "dashboard count fixture",
      reported_by: driver!.id,
      reported_at: new Date(),
      closed_at: opts.closedAt ?? null,
    },
  });
}

async function dashboardOpenExceptions(): Promise<number | undefined> {
  const admin = await loginAs(ADMIN);
  const res = await api().get("/api/v1/reports/dashboard").set(auth(admin));
  expect(res.status).toBe(200);
  return res.body.open_exceptions;
}

describe("GET /reports/dashboard — open_exceptions", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.FEATURE_EXCEPTIONS = "true";
  });
  afterEach(() => {
    delete process.env.FEATURE_EXCEPTIONS;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is 0 on a fleet with nothing reported", async () => {
    expect(await dashboardOpenExceptions()).toBe(0);
  });

  it("counts the OPEN reports and ignores the closed ones", async () => {
    await seedException();
    await seedException();
    await seedException({ closedAt: new Date() });

    // Three rows exist; two are still somebody's problem.
    expect(await prisma.tripException.count()).toBe(3);
    expect(await dashboardOpenExceptions()).toBe(2);
  });

  it("drops back as reports are closed", async () => {
    const exc = await seedException();
    expect(await dashboardOpenExceptions()).toBe(1);

    await prisma.tripException.update({ where: { id: exc.id }, data: { closed_at: new Date() } });
    expect(await dashboardOpenExceptions()).toBe(0);
  });

  it("reports 0 while FEATURE_EXCEPTIONS is off, even with open reports in the table", async () => {
    // Same gating as every other exception read: with the feature dark the rest
    // of the API 404s on this data, so the dashboard must not be the one place
    // that counts it. This is also what production returns today.
    await seedException();
    delete process.env.FEATURE_EXCEPTIONS;
    expect(await dashboardOpenExceptions()).toBe(0);
  });
});
