import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  userIdByPhone,
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  num,
} from "./helpers/flow";

/**
 * R5 A4 AT THE APPROVAL BOUNDARY — only the last trip of the day earns the
 * after-6pm rate.
 *
 * `tests/lastTripOt.test.ts` drives the decision with a stub client and covers
 * every branch. It cannot tell you whether the approve route calls it, and a
 * money rule nobody calls is worth nothing. These run the real
 * `PATCH /trips/:id/approve-incentive` against Postgres and read
 * `incentive_final` — the payable number.
 *
 * ⚠ WHY THE OFF-PEAK PROPOSAL IS WRITTEN IN, not delivered into existence: the
 * tier is chosen at finalization from the real delivery clock, and the suite
 * cannot deliver at 19:00 MYT on demand (freezing the clock is banned here — the
 * server derives the window, the tier and every arrival stamp from it). So each
 * trip is delivered normally and its PROPOSAL is then set to what an after-6pm
 * run would have produced. What is under test is the approval decision, which is
 * exactly the part that reads those columns.
 *
 * ⚠ MEASURED, by removing the `resolveLastTripOt` call from the approve route:
 *
 *   tests/lastTripOt.test.ts ....... 14 passed. Notices NOTHING.
 *   this file ...................... 3 of 5 RED (expected 52 to be 44, twice,
 *                                    and the audit row loses its reason).
 *
 * The two that survive are the ones asserting NO demotion — the day's last trip
 * and the admin override. They are negative guards, not discriminators: they go
 * red if the rule fires when it should not, which is the other way this can be
 * wrong and is worth just as much.
 *
 * RM52 instead of RM44 is the overpayment A4 exists to prevent, and one BL9
 * makes permanent.
 *
 * Seeded PND 1888: Ipoh (A2) 6 pts, Kulim (K1) 3 pts, deduction 2, RM11/RM13.
 */
const TRUCK = "PND 1888";
const OFF_PEAK = 13;
const WEEKDAY = 11;

let requestor = "", admin = "", driver = "", driverId = "", rt = "";

/** Deliver a single-stop trip in `zone`, leaving it in pending_approval. */
async function deliverTrip(zone: string): Promise<string> {
  const trip = await bookTrip(requestor, [zone], rt);
  await approveTrip(admin, trip.id, driverId, TRUCK, true);
  await startTrip(driver, trip.id);
  await arriveAndDeliver(driver, trip.id, trip.stops[0].id);
  return trip.id;
}

/** Make a delivered trip's proposal read as an after-6pm one worth `points`. */
async function proposeAsOffPeak(tripId: string, points: number): Promise<void> {
  await prisma.trip.update({
    where: { id: tripId },
    data: { off_peak: true, rate_used: OFF_PEAK, incentive_earned: points * OFF_PEAK },
  });
}

const approveIncentive = (tripId: string, body: Record<string, unknown> = {}) =>
  api().patch(`/api/v1/trips/${tripId}/approve-incentive`).set(auth(admin)).send(body);

const finalOf = (tripId: string) =>
  prisma.trip.findUniqueOrThrow({
    where: { id: tripId },
    select: { incentive_final: true, incentive_override_reason: true },
  });

describe("R5 A4 — the after-6pm rate survives approval only on the day's last trip", () => {
  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });

  beforeEach(async () => {
    await resetDb();
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });

  it("an earlier trip is approved at the WEEKDAY rate once a later one exists", async () => {
    const earlier = await deliverTrip("A2");
    await proposeAsOffPeak(earlier, 4); // RM52 proposed
    await deliverTrip("K1"); // the driver went out again, later the same day

    expect((await approveIncentive(earlier)).status).toBe(200);

    const row = await finalOf(earlier);
    expect(num(row.incentive_final)).toBe(4 * WEEKDAY); // RM44, not RM52
    expect(row.incentive_override_reason).toContain("A4");
  });

  it("the LAST trip of the day keeps its after-6pm rate", async () => {
    const only = await deliverTrip("A2");
    await proposeAsOffPeak(only, 4);

    expect((await approveIncentive(only)).status).toBe(200);

    const row = await finalOf(only);
    expect(num(row.incentive_final)).toBe(4 * OFF_PEAK); // RM52 stands
    expect(row.incentive_override_reason).toBeNull();
  });

  /**
   * Mr. Teh, 16 Jul 2026: "admin also can edit the final rate prior approval."
   * That lever outranks this rule — an admin looking at the trip and typing a
   * number is deciding deliberately, and A4 only re-prices the PROPOSAL.
   */
  it("an admin's own final_amount wins over the demotion", async () => {
    const earlier = await deliverTrip("A2");
    await proposeAsOffPeak(earlier, 4);
    await deliverTrip("K1");

    const res = await approveIncentive(earlier, { final_amount: 50, reason: "goodwill, agreed with Teh" });
    expect(res.status).toBe(200);

    const row = await finalOf(earlier);
    expect(num(row.incentive_final)).toBe(50);
    expect(row.incentive_override_reason).toContain("goodwill");
  });

  /**
   * ⚠ A LATER TRIP WHERE EVERYTHING FAILED IS STILL A LATER TRIP. The driver
   * went out again; nothing was delivered. The rule reads ARRIVALS as well as
   * deliveries for exactly this case, and that choice can only ever demote —
   * the direction that cannot overpay.
   */
  it("a later trip counts even if the driver delivered nothing on it", async () => {
    const earlier = await deliverTrip("A2");
    await proposeAsOffPeak(earlier, 4);

    const later = await bookTrip(requestor, ["K1"], rt);
    await approveTrip(admin, later.id, driverId, TRUCK, true);
    await startTrip(driver, later.id);
    await api()
      .patch(`/api/v1/trips/${later.id}/status`)
      .set(auth(driver))
      .send({ action: "arrived", stop_id: later.stops[0].id });

    expect((await approveIncentive(earlier)).status).toBe(200);
    expect(num((await finalOf(earlier)).incentive_final)).toBe(4 * WEEKDAY);
  });

  it("the audit trail records the demotion as an edit, with the rule as its reason", async () => {
    const earlier = await deliverTrip("A2");
    await proposeAsOffPeak(earlier, 4);
    await deliverTrip("K1");
    await approveIncentive(earlier);

    const log = await prisma.auditLog.findFirst({
      where: { record_id: earlier, action: { startsWith: "trip.incentive_approved" } },
      orderBy: { timestamp: "desc" },
    });
    // Before→after AND why. An approval that quietly paid less than it proposed
    // would leave the driver's question unanswerable six weeks later.
    expect(log?.action).toContain("RM52");
    expect(log?.action).toContain("RM44");
    expect(log?.action).toContain("A4");
  });
});
