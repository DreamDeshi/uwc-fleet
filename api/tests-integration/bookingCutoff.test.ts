import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import { ensureConsigneeInZone, firstRouteTypeId } from "./helpers/flow";

/**
 * B7 — THE CUT-OFFS, ENFORCED BY THE ROUTE.
 *
 * `tests/bookingCutoff.test.ts` proves the arithmetic at the minute. It cannot
 * prove the booking route ASKS — the verdict function is pure, and a pure
 * function nobody calls is worth nothing. These cases book through the real
 * HTTP endpoint.
 *
 * ⚠ TIME IS FAKED HERE, DELIBERATELY, AND ONLY `Date`.
 * The rule compares the request instant with the requested pickup, so a test
 * that used the real clock would assert something different at each hour and
 * could only exercise the CLOSED path between 08:30 and 23:00 MYT — the exact
 * shape of the daily failure band this suite has been bitten by before. Vitest
 * fakes `Date` alone (`toFake: ["Date"]`), so timers, Prisma and the HTTP stack
 * run normally; only the clock the route reads moves. This is not the e2e
 * suite's forbidden fake clock: there, freezing one of two clocks invents a
 * skew production never has. Here there is one process and one clock.
 *
 * Monday 10 Aug 2026 is a plain working day: no holiday, not a weekend, so the
 * "next working day" is simply Tuesday.
 */

/** A UTC instant for a MYT wall-clock time on Monday 10 Aug 2026. */
const myt = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 7, 10, hour, minute) - 8 * 60 * 60 * 1000);
/** The same on Tuesday. */
const mytTue = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 7, 11, hour, minute) - 8 * 60 * 60 * 1000);

function freeze(instant: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

async function routeTypeIdNamed(token: string, name: string): Promise<string> {
  const res = await api().get("/api/v1/route-types").set(auth(token));
  const rt = (res.body as { id: string; name: string }[]).find((r) => r.name === name);
  if (!rt) throw new Error(`route type ${name} not seeded: ${res.text}`);
  return rt.id;
}

async function book(token: string, routeTypeId: string, pickup: Date) {
  const c = await ensureConsigneeInZone("P1");
  return api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: routeTypeId,
      pickup_datetime: pickup.toISOString(),
      stops: [{ consignee_id: c.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
}

describe("B7 — booking cut-offs at the route", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("REFUSES a today-morning pickup booked after 08:30, and says what to do", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 0)); // 09:00 MYT — the morning cut-off has passed
    const res = await book(requestor, delivery, myt(11, 0)); // still a morning pickup

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PICKUP_AFTER_CUTOFF");
    expect(res.body.error.message).toBe(
      "Morning pickups close at 8:30am. The earliest pickup you can book now is 2026-08-11."
    );
    expect(await prisma.trip.count()).toBe(0); // nothing was written
  });

  it("ACCEPTS the same booking made at 08:29", async () => {
    // The discriminator for the whole rule: identical request, one minute
    // earlier. If this failed too, the route would be rejecting for some other
    // reason and the case above would prove nothing.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(8, 29));
    expect((await book(requestor, delivery, myt(11, 0))).status).toBe(201);
  });

  it("ACCEPTS a today-AFTERNOON pickup at 09:00 — the sessions close separately", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 0));
    expect((await book(requestor, delivery, myt(15, 0))).status).toBe(201);
  });

  it("REFUSES that afternoon pickup once 13:30 has passed", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(14, 0));
    const res = await book(requestor, delivery, myt(15, 0));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Afternoon pickups close at 1:30pm");
  });

  it("ACCEPTS tomorrow morning at 23:00 tonight — only today is gated", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(23, 0));
    expect((await book(requestor, delivery, mytTue(9, 0))).status).toBe(201);
  });

  it("EXEMPTS return cargo — his own sentence, 'anytime before 12am'", async () => {
    const requestor = await loginAs(REQUESTOR);
    const ret = await routeTypeIdNamed(requestor, "Customer Return");

    freeze(myt(23, 0)); // long past both cut-offs
    // 23:30 MYT the same day: still today, still a return, still allowed.
    expect((await book(requestor, ret, myt(23, 30))).status).toBe(201);
  });

  it("does not bind an ADMIN — the office IS the dispatcher", async () => {
    // ⚠ A judgement, not something Mr. Teh said. Same reasoning that leaves
    // manual assignment ungated everywhere else. Stated here so it is visible
    // rather than buried in the route.
    const admin = await loginAs(ADMIN);
    const delivery = await routeTypeIdNamed(admin, "Customer Delivery");

    freeze(myt(14, 0));
    expect((await book(admin, delivery, myt(15, 0))).status).toBe(201);
  });

  it("binds an EDIT that MOVES the pickup, so the rule cannot be walked around", async () => {
    // Book tomorrow at 09:00 (allowed), then at 14:00 try to pull it back to
    // this afternoon. Without this the whole rule is one edit away from
    // useless.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 0));
    const created = await book(requestor, delivery, mytTue(9, 0));
    expect(created.status).toBe(201);

    freeze(myt(14, 0));
    const moved = await api()
      .patch(`/api/v1/trips/${created.body.id}`)
      .set(auth(requestor))
      .send({
        route_type_id: delivery,
        pickup_datetime: myt(15, 0).toISOString(),
        stops: created.body.stops.map((s: { consignee_id: string }) => ({ consignee_id: s.consignee_id })),
      });
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe("PICKUP_AFTER_CUTOFF");
  });

  it("lets an edit that does NOT move the pickup through, at any hour", async () => {
    // A requestor fixing a consignee at 16:00 must not be told to rebook a time
    // he never touched.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 0));
    const created = await book(requestor, delivery, mytTue(9, 0));
    const other = await ensureConsigneeInZone("P2");

    freeze(myt(16, 0));
    const edited = await api()
      .patch(`/api/v1/trips/${created.body.id}`)
      .set(auth(requestor))
      .send({
        route_type_id: delivery,
        pickup_datetime: mytTue(9, 0).toISOString(), // unchanged
        stops: [{ consignee_id: other.id }],
      });
    expect(edited.status).toBe(200);
  });
});
