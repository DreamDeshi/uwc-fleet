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

async function book(token: string, routeTypeId: string, pickup: Date, overrideReason?: string) {
  const c = await ensureConsigneeInZone("P1");
  return api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: routeTypeId,
      pickup_datetime: pickup.toISOString(),
      stops: [{ consignee_id: c.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      ...(overrideReason ? { cutoff_override_reason: overrideReason } : {}),
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

  it("REFUSES a today-morning pickup booked after 10:00, and says what to do", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(10, 30)); // 10:30 MYT — the morning cut-off has passed
    const res = await book(requestor, delivery, myt(11, 0)); // still a morning pickup

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PICKUP_AFTER_CUTOFF");
    expect(res.body.error.message).toBe(
      "Morning pickups close at 10:00am. The earliest pickup you can book now is 2026-08-11."
    );
    expect(await prisma.trip.count()).toBe(0); // nothing was written
  });

  it("ACCEPTS the same booking made at 09:59", async () => {
    // The discriminator for the whole rule: identical request, one minute
    // earlier. If this failed too, the route would be rejecting for some other
    // reason and the case above would prove nothing.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 59));
    expect((await book(requestor, delivery, myt(11, 0))).status).toBe(201);
  });

  it("ACCEPTS an INTERPLANT delivery at any hour — exempt entirely, same as a return (Teh, 27 Aug 2:19pm)", async () => {
    const requestor = await loginAs(REQUESTOR);
    const interplant = await routeTypeIdNamed(requestor, "Inter-Plant Delivery");

    freeze(myt(15, 30)); // long past both cut-offs
    expect((await book(requestor, interplant, myt(16, 0))).status).toBe(201);

    // The exact instant/pickup pair the CUSTOMER delivery test above just
    // proved is REFUSED — same clock, same pickup, only the route type
    // differs, so this discriminates the exemption rather than coincidence.
    freeze(myt(10, 30));
    expect((await book(requestor, interplant, myt(11, 0))).status).toBe(201);
  });

  it("ACCEPTS a today-AFTERNOON pickup at 10:30 — the sessions close separately", async () => {
    // 10:30 rather than 09:00: the morning cut-off (10:00) has to have ALREADY
    // passed for this to prove anything — otherwise it would pass trivially
    // regardless of whether sessions close independently.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(10, 30));
    expect((await book(requestor, delivery, myt(15, 0))).status).toBe(201);
  });

  it("REFUSES that afternoon pickup once 15:00 has passed", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(15, 30));
    const res = await book(requestor, delivery, myt(16, 0));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Afternoon pickups close at 3:00pm");
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

  /**
   * THE ADMIN OVERRIDE (owner ruling, 12 Aug 2026).
   *
   * Read literally, B7 removes ALL same-day booking after the afternoon cut-off
   * (15:00 since 27 Aug 2026, was 13:30) while the working day runs to
   * midnight — several hours of capacity the office could not use, and urgent
   * same-day work exists (Mr. Teh's own Sheet1: "CONQUEST
   * (est 2 pallet P7 URGENT"). The rule binds the REQUESTOR; the admin steps
   * outside it on the record. Same shape as email pt 6 (admin authorises
   * cross-class swaps), R3 A7 (admin decides when the fleet is full) and A19
   * (admin edits at every status).
   */
  it("REFUSES an admin who gives no reason — an override must be deliberate", async () => {
    // This is what keeps it an override rather than an exemption. An admin who
    // lands here by accident is stopped exactly as a requestor is.
    const admin = await loginAs(ADMIN);
    const delivery = await routeTypeIdNamed(admin, "Customer Delivery");

    freeze(myt(15, 30));
    const res = await book(admin, delivery, myt(16, 0));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CUTOFF_OVERRIDE_REASON_REQUIRED");
    expect(res.body.error.message).toContain("give a reason");
    expect(await prisma.trip.count()).toBe(0);
  });

  it("ALLOWS an admin who gives one, and writes WHO and WHY", async () => {
    const admin = await loginAs(ADMIN);
    const delivery = await routeTypeIdNamed(admin, "Customer Delivery");

    freeze(myt(15, 30));
    const res = await book(admin, delivery, myt(16, 0), "CONQUEST urgent, 2 pallets to P7");
    expect(res.status).toBe(201);

    // WHO: an audit row under its own action, so this is a query rather than a
    // scan of free text.
    const rows = await prisma.auditLog.findMany({
      where: { action: "trip.cutoff_override", record_id: res.body.id },
      select: { user_id: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe((await prisma.user.findFirstOrThrow({ where: { role: "admin" } })).id);

    // WHY: on the trip's own immutable timeline, where the admin trip detail
    // already renders it.
    const events = await prisma.tripStatusHistory.findMany({ where: { trip_id: res.body.id } });
    expect(events).toHaveLength(1);
    expect(events[0].note).toBe(
      "Admin override: booked past the 3:00pm afternoon cut-off — CONQUEST urgent, 2 pallets to P7"
    );
  });

  it("does NOT record an override when nothing was overridden", async () => {
    // A reason sent on an ordinary booking must not become free text attached
    // to the trip, nor a spurious audit row implying a rule was bypassed.
    const admin = await loginAs(ADMIN);
    const delivery = await routeTypeIdNamed(admin, "Customer Delivery");

    freeze(myt(9, 0)); // afternoon still open
    const res = await book(admin, delivery, myt(15, 0), "not actually needed");
    expect(res.status).toBe(201);
    expect(
      await prisma.auditLog.count({ where: { action: "trip.cutoff_override", record_id: res.body.id } })
    ).toBe(0);
    const events = await prisma.tripStatusHistory.findMany({ where: { trip_id: res.body.id } });
    expect(events[0].note).toBeNull();
  });

  it("a REQUESTOR cannot override, whatever reason they send", async () => {
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(15, 30));
    const res = await book(requestor, delivery, myt(16, 0), "please, it is urgent");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PICKUP_AFTER_CUTOFF"); // not the override path
    expect(await prisma.trip.count()).toBe(0);
  });

  it("binds an EDIT that MOVES the pickup, so the rule cannot be walked around", async () => {
    // Book tomorrow at 09:00 (allowed), then at 15:30 try to pull it back to
    // this afternoon. Without this the whole rule is one edit away from
    // useless.
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    freeze(myt(9, 0));
    const created = await book(requestor, delivery, mytTue(9, 0));
    expect(created.status).toBe(201);

    freeze(myt(15, 30));
    const moved = await api()
      .patch(`/api/v1/trips/${created.body.id}`)
      .set(auth(requestor))
      .send({
        route_type_id: delivery,
        pickup_datetime: myt(16, 0).toISOString(),
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

  /**
   * THE ADMIN-EDITABLE SETTING (Teh, WhatsApp, 27 Aug 2026 — "yes" to a
   * flexible system for the admin to change the cut-off time). This proves
   * the ROUTE actually reads the effective setting, not just that
   * `bookingCutoffVerdict` accepts an override parameter in isolation — per
   * AGENTS.md, a unit test calling the pure function directly cannot tell
   * "wired in" from "dead code accepting an unused parameter".
   */
  it("PATCHing booking.afternoon_cutoff_min changes what the route actually accepts", async () => {
    const admin = await loginAs(ADMIN);
    const requestor = await loginAs(REQUESTOR);
    const delivery = await routeTypeIdNamed(requestor, "Customer Delivery");

    // At the DEFAULT (15:00), 14:30 is still open for a same-day afternoon pickup.
    freeze(myt(14, 30));
    expect((await book(requestor, delivery, myt(15, 0))).status).toBe(201);

    // An admin moves the cut-off two hours earlier, to 13:00.
    const patch = await api()
      .patch("/api/v1/settings/booking.afternoon_cutoff_min")
      .set(auth(admin))
      .send({ value: 13 * 60 });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ key: "booking.afternoon_cutoff_min", value: 13 * 60 });

    // The SAME wall-clock instant that was accepted a moment ago is now refused.
    const res = await book(requestor, delivery, myt(15, 30));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PICKUP_AFTER_CUTOFF");
    // The message reflects the NEW time, not the stale "3:00pm" default text.
    expect(res.body.error.message).toContain("Afternoon pickups close at 1:00pm");

    // Audited: who changed it, and the old→new value.
    const audit = await prisma.auditLog.findFirst({
      where: { action: { contains: "setting.updated booking.afternoon_cutoff_min" } },
    });
    expect(audit?.action).toBe(`setting.updated booking.afternoon_cutoff_min ${15 * 60}→${13 * 60}`);
    expect(audit?.table_name).toBe("Setting");

    // Resetting it restores the default (15:00) behaviour.
    const del = await api()
      .delete("/api/v1/settings/booking.afternoon_cutoff_min")
      .set(auth(admin));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ key: "booking.afternoon_cutoff_min", value: 15 * 60 });
    expect((await book(requestor, delivery, myt(15, 0))).status).toBe(201);
  });

  it("a REQUESTOR cannot change a setting, only read it", async () => {
    const requestor = await loginAs(REQUESTOR);
    const patch = await api()
      .patch("/api/v1/settings/booking.afternoon_cutoff_min")
      .set(auth(requestor))
      .send({ value: 12 * 60 });
    expect(patch.status).toBe(403);

    const list = await api().get("/api/v1/settings").set(auth(requestor));
    expect(list.status).toBe(200);
    expect(list.body.settings.find((s: { key: string }) => s.key === "booking.afternoon_cutoff_min")).toMatchObject(
      { value: 15 * 60, source: "default" }
    );
  });

  it("rejects an out-of-range value rather than silently clamping it", async () => {
    const admin = await loginAs(ADMIN);
    const res = await api()
      .patch("/api/v1/settings/booking.morning_cutoff_min")
      .set(auth(admin))
      .send({ value: 1440 }); // one past 23:59
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SETTING_VALUE");
    // Unchanged — the bad write must not have landed.
    const list = await api().get("/api/v1/settings").set(auth(admin));
    expect(
      list.body.settings.find((s: { key: string }) => s.key === "booking.morning_cutoff_min")
    ).toMatchObject({ value: 8 * 60 + 30, source: "default" });
  });
});
