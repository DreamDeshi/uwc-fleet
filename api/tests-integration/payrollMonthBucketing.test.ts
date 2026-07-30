import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The exception case posts a real photo. Cloudinary rejects synthetic bytes as
// "Invalid image file", so the adapter is mocked exactly as the other suites
// that upload do — the subject here is the pay MONTH, not the image pipeline.
vi.mock("../src/lib/cloudinary", () => ({
  uploadBuffer: vi.fn(async (_b: Buffer, folder: string) => ({
    url: `https://res.cloudinary.test/${folder}/authenticated`,
    publicId: `${folder}/pub_${randomUUID()}`,
    resourceType: "image",
    format: "jpg",
  })),
  isCloudinaryConfigured: () => true,
  cloudinary: { url: (id: string) => `https://res.cloudinary.test/signed/${id}` },
}));

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  bookTrip,
  approveTrip,
  startTrip,
  arriveDeliverApprove,
  approveIncentive,
  firstRouteTypeId,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";

/**
 * PAYROLL MONTH BUCKETING — the clerk's sheet, end to end.
 *
 * The known failure shape is a DISAGREEMENT BETWEEN TWO LAYERS. The route's SQL
 * takes a deliberate SUPERSET of the month —
 *
 *     earnedInWindow(stops) in [start, end)   OR   pickup_datetime in [start, end)
 *
 * — and buildPayrollRows then applies the precise pay-day predicate in memory.
 * Both layers are individually unit-tested. Nothing tested them AGREEING, which
 * is the only thing that matters: `points_awarded` was added to the pay
 * predicate and not threaded into firstEarningInstant, so earnedInWindow moved
 * to the persisted rule while every payroll path stayed on the live one, and
 * the two then disagreed about a paid trip's month. The SQL said August and the
 * bucket said July.
 *
 * Every case here therefore asserts BOTH months — present in the right one AND
 * absent from the wrong one. Asserting only "it appears in August" would pass
 * just as happily if the trip appeared in every month of the year.
 *
 * MYT is UTC+8 with no DST, so a July MYT month is [2026-06-30T16:00Z,
 * 2026-07-31T16:00Z).
 */

const JULY = "2026-07";
const AUGUST = "2026-08";

/** An instant expressed in MYT wall-clock, returned as the UTC Date it is. */
const myt = (iso: string) => new Date(`${iso}+08:00`);

interface PayrollTripLine {
  id: string;
  ticket_number: string;
  incentive_earned: number;
}

async function payrollTripIds(adminToken: string, month: string): Promise<string[]> {
  const res = await api().get(`/api/v1/reports/payroll?month=${month}`).set(auth(adminToken));
  expect(res.status, res.text).toBe(200);
  expect(res.body.month).toBe(month);
  return (res.body.drivers as { trips: PayrollTripLine[] }[]).flatMap((d) => d.trips.map((t) => t.id));
}

async function payrollTotalFor(adminToken: string, month: string, driverId: string): Promise<number> {
  const res = await api().get(`/api/v1/reports/payroll?month=${month}`).set(auth(adminToken));
  const row = (res.body.drivers as { driver_id: string; total: number }[]).find((d) => d.driver_id === driverId);
  return row?.total ?? 0;
}

describe("payroll month bucketing — SQL bound and in-memory predicate must agree", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";

  beforeAll(async () => {
    process.env.FEATURE_EXCEPTIONS = "true";
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => {
    delete process.env.FEATURE_EXCEPTIONS;
    await prisma.$disconnect();
  });
  beforeEach(async () => { await resetDb(); });

  /** A completed, paid, single-stop trip — the normal shape a sheet is built from. */
  async function completedTrip(): Promise<{ id: string; stopId: string }> {
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveDeliverApprove(driver, admin, t.id, stopId);
    return { id: t.id, stopId };
  }

  it("a trip PICKED UP in July and DELIVERED in August is August money, and is absent from July", async () => {
    // The case the superset SQL cannot decide on its own: its pickup_datetime
    // arm matches JULY, so the trip IS selected for the July sheet and only the
    // in-memory predicate removes it. If the two layers drift, it shows up twice
    // — or in the wrong month — and a driver is paid in the wrong period.
    const { id, stopId } = await completedTrip();
    await prisma.trip.update({ where: { id }, data: { pickup_datetime: myt("2026-07-31T23:30:00") } });
    await prisma.tripStop.update({ where: { id: stopId }, data: { delivered_at: myt("2026-08-01T02:15:00") } });

    expect(await payrollTripIds(admin, AUGUST)).toContain(id);
    expect(await payrollTripIds(admin, JULY)).not.toContain(id);
  });

  it("buckets on MYT, not UTC — a delivery at 17:30 UTC on 31 July is August", async () => {
    // 2026-07-31T17:30Z is 2026-08-01 01:30 in MYT. Anyone bucketing on the raw
    // UTC month puts this in July; the driver's pay period would be off by one
    // for every late-evening delivery at a month end.
    const { id, stopId } = await completedTrip();
    await prisma.trip.update({ where: { id }, data: { pickup_datetime: myt("2026-07-31T22:00:00") } });
    await prisma.tripStop.update({
      where: { id: stopId },
      data: { delivered_at: new Date("2026-07-31T17:30:00.000Z") },
    });

    expect(await payrollTripIds(admin, AUGUST)).toContain(id);
    expect(await payrollTripIds(admin, JULY)).not.toContain(id);
  });

  it("a trip delivered WELL INSIDE July stays in July — the control", async () => {
    // Without this, the two cases above would pass if the sheet had simply
    // stopped returning anything for July at all.
    const { id, stopId } = await completedTrip();
    await prisma.trip.update({ where: { id }, data: { pickup_datetime: myt("2026-07-15T09:00:00") } });
    await prisma.tripStop.update({ where: { id: stopId }, data: { delivered_at: myt("2026-07-15T11:00:00") } });

    expect(await payrollTripIds(admin, JULY)).toContain(id);
    expect(await payrollTripIds(admin, AUGUST)).not.toContain(id);
  });

  it("an UNDELIVERED-BUT-PAID stop buckets on its ARRIVAL, not the pickup — the exact threading that broke", async () => {
    // R3 Q11(a): a stop the driver reached but could not deliver, verified and
    // resumed by the office, is paid the same as a delivered one. It has NO
    // delivered_at, so its earning instant is `arrived_at` — and reaching that
    // branch requires firstEarningInstant to pass points_awarded through to
    // stopPayEligibility. When it did not, the trip fell back to
    // payAttributionInstant's pickup and landed in the WRONG MONTH while
    // earnedInWindow (already on the persisted rule) said the right one.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;

    await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    const report = await api()
      .post(`/api/v1/trips/${t.id}/exception`)
      .set(auth(driver))
      .field("category", "customer_site")
      .field("reason", "gate locked")
      .field("client_occurrence_id", randomUUID())
      .field("client_action_id", randomUUID())
      .field("client_evidence_id", randomUUID())
      .field("trip_stop_id", stopId)
      .attach("photo", Buffer.from("fake-jpeg-bytes"), "e.jpg");
    expect(report.status, report.text).toBe(201);
    const exId = report.body.exception.id as string;

    for (const action of ["verify", "resume"]) {
      const res = await api()
        .post(`/api/v1/trips/${t.id}/exception/${exId}/${action}`)
        .set(auth(admin))
        .send({ client_action_id: randomUUID() });
      expect(res.status, `${action}: ${res.text}`).toBe(200);
    }
    // approveIncentive throws on a non-200 — the earlier version of this line
    // hit a wrong path and swallowed the failure, so the trip never reached
    // `completed` and the payroll query (status: "completed") returned nothing.
    await approveIncentive(admin, t.id);
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("completed");

    // Genuinely paid, with the persisted evidence the predicate reads.
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } });
    expect(stop.delivered_at, "this stop must have NO delivery confirm").toBeNull();
    expect(stop.points_awarded, "the persisted scoring evidence must exist").not.toBeNull();

    // THE DIVERGENCE. stopPayEligibility short-circuits on points_awarded
    // ("SCORED WINS", undeliveredPay.ts) BEFORE it consults the live exception
    // state, so the persisted and live rules only disagree once something has
    // changed after finalization. A reject landing on an already-paid stop is
    // exactly that case, and the source anticipates it: "only reachable
    // post-finalization".
    //
    // Without it this test cannot fail — verified by reintroducing the bug and
    // watching it stay green. With points_awarded unthreaded the live rule was
    // still satisfied (verified + resumed), so arrived_at was used anyway and
    // the month came out right for the wrong reason.
    //
    // Written straight to the database because the API path to this state is
    // guarded once a trip is completed; the subject is the two predicates
    // disagreeing, not how the row got there.
    await prisma.tripException.create({
      data: {
        trip_id: t.id,
        trip_stop_id: stopId,
        client_occurrence_id: randomUUID(),
        category: "customer_site",
        reason: "late reject on an already-paid stop",
        reported_by: driverId,
        current_state: "rejected",
        closed_at: new Date(),
      },
    });

    // Pickup in July, arrival (the earning instant) in August.
    await prisma.trip.update({ where: { id: t.id }, data: { pickup_datetime: myt("2026-07-31T22:00:00") } });
    await prisma.tripStop.update({ where: { id: stopId }, data: { arrived_at: myt("2026-08-01T01:00:00") } });

    expect(await payrollTripIds(admin, AUGUST)).toContain(t.id);
    expect(await payrollTripIds(admin, JULY)).not.toContain(t.id);
    // And it is real money, not a zero line that happens to sit in a month.
    expect(await payrollTotalFor(admin, AUGUST, driverId)).toBeGreaterThan(0);
  });
});
