import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { api, auth, prisma, resetDb, loginAs, REQUESTOR, ADMIN } from "./helpers/harness";
import { firstRouteTypeId, ensureConsigneeInZone, futurePickupIso } from "./helpers/flow";
import { isUniqueViolation, isUniqueViolationOnField } from "../src/lib/prismaErrors";

/**
 * DG-T7 — a retried booking must NOT become a second booking.
 *
 * Real failure: the mobile client times out at 15s and re-arms Submit in a
 * `finally`, so a submit that timed out but actually committed gets sent
 * again. With `dispatch_mode = auto` (which is how prod runs — client-approved)
 * dispatch fires inline on create, so the duplicate immediately claims a
 * SECOND TRUCK for a delivery that only exists once.
 *
 * The ticket-collision retry loop does not help: it GUARANTEES the retry gets a
 * fresh ticket number, so the duplicate looks like a legitimate new booking.
 */

let requestor = "", requestor2 = "", rt = "";

async function book(token: string, body: Record<string, unknown>) {
  const c = await ensureConsigneeInZone("P2");
  return api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: c.id, sequence: 1 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      ...body,
    });
}

describe("booking idempotency — DG-T7", () => {
  beforeAll(async () => {
    requestor = await loginAs(REQUESTOR);
    rt = await firstRouteTypeId(requestor);
    // A second requestor account to prove the key is scoped, not global.
    requestor2 = await loginAs(ADMIN);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  it("returns the ORIGINAL booking when the same key is submitted twice", async () => {
    const key = "retry-key-0000000000000001";

    const first = await book(requestor, { client_request_id: key });
    expect(first.status).toBe(201);

    // The retry the requestor's phone sends after the timeout.
    const second = await book(requestor, { client_request_id: key });
    expect(second.status).toBe(201);

    // Same trip — not merely equivalent, the SAME row.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.ticket_number).toBe(first.body.ticket_number);

    // And exactly one trip exists, so auto-dispatch can only have claimed one truck.
    const count = await prisma.trip.count({ where: { client_request_id: key } });
    expect(count).toBe(1);
  });

  it("still creates a second booking for a DIFFERENT key — real re-bookings work", async () => {
    const a = await book(requestor, { client_request_id: "distinct-key-aaaaaaaaaaaa" });
    const b = await book(requestor, { client_request_id: "distinct-key-bbbbbbbbbbbb" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("never returns ANOTHER requestor's booking for the same key", async () => {
    // The reason the constraint is composite. A global key would let a guessed
    // or replayed value surface someone else's booking.
    const key = "shared-key-000000000000001";
    const mine = await book(requestor, { client_request_id: key });
    const theirs = await book(requestor2, { client_request_id: key });

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(await prisma.trip.count({ where: { client_request_id: key } })).toBe(2);
  });

  it("CONCURRENT identical submits collapse to one booking (the constraint, not the pre-check)", async () => {
    // The sequential test above is satisfied by the fast-path lookup alone.
    // This one overlaps the requests deliberately: all four are in flight at
    // once, so the pre-check can find nothing for several of them and the real
    // Postgres unique index has to be what stops the duplicates.
    const key = "concurrent-key-000000000001";

    // Resolve ALL setup first. The per-call helper awaits a consignee lookup,
    // which serialised the requests enough that the first create committed
    // before the others even reached their pre-check — so the constraint never
    // fired and this test silently proved only the fast path. Building the
    // payload up front means the four POSTs genuinely leave together.
    const c = await ensureConsigneeInZone("P2");
    const payload = {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: c.id, sequence: 1 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      client_request_id: key,
    };
    const fire = () => api().post("/api/v1/trips").set(auth(requestor)).send(payload);

    const responses = await Promise.all([fire(), fire(), fire(), fire()]);

    for (const r of responses) expect(r.status).toBe(201);
    // Every caller gets the same trip — no request is told "yours didn't happen".
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    // And the database holds exactly one, so auto-dispatch saw one booking.
    expect(await prisma.trip.count({ where: { client_request_id: key } })).toBe(1);
  });

  it("the REAL Postgres unique index rejects a duplicate key, naming the column", async () => {
    // Proves two things the handler depends on: the composite index actually
    // exists in the migrated database, and Prisma reports target metadata that
    // NAMES client_request_id — which is what isUniqueViolationOnField needs in
    // order to tell this apart from a ticket_number collision.
    const requestorId = (await prisma.user.findUnique({ where: { phone: REQUESTOR.phone } }))!.id;
    const routeTypeId = (await prisma.routeType.findFirst())!.id;
    const key = "db-constraint-key-0000000001";
    const row = {
      requestor_id: requestorId,
      route_type_id: routeTypeId,
      pickup_datetime: new Date(Date.now() + 3600_000),
      client_request_id: key,
    };

    await prisma.trip.create({ data: { ...row, ticket_number: "TKT-CONSTRAINT-001" } });

    let caught: unknown;
    try {
      // Same requestor + same key, DIFFERENT ticket — only the idempotency
      // constraint can reject this.
      await prisma.trip.create({ data: { ...row, ticket_number: "TKT-CONSTRAINT-002" } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    const target = (caught as Prisma.PrismaClientKnownRequestError).meta?.target;
    expect(String(target)).toContain("client_request_id");
    // The strict matcher the create loop relies on agrees.
    expect(isUniqueViolationOnField(caught, "client_request_id")).toBe(true);
    expect(isUniqueViolationOnField(caught, "ticket_number")).toBe(false);
  });

  it("a ticket_number collision names ONLY ticket_number — it cannot enter the replay branch", async () => {
    // Step 6: the two unique constraints must stay distinguishable in the real
    // database. If a ticket collision ever reported client_request_id (or no
    // target at all), the create loop would return a "duplicate" instead of
    // retrying with a bumped sequence.
    const requestorId = (await prisma.user.findUnique({ where: { phone: REQUESTOR.phone } }))!.id;
    const routeTypeId = (await prisma.routeType.findFirst())!.id;
    const ticket = "TKT-COLLIDE-0001";
    const row = {
      requestor_id: requestorId,
      route_type_id: routeTypeId,
      pickup_datetime: new Date(Date.now() + 3600_000),
      ticket_number: ticket,
    };

    await prisma.trip.create({ data: { ...row, client_request_id: "ticket-collide-key-aaaaaaa" } });

    let caught: unknown;
    try {
      // Same ticket, DIFFERENT key → only ticket_number can be the violation.
      await prisma.trip.create({ data: { ...row, client_request_id: "ticket-collide-key-bbbbbbb" } });
    } catch (err) {
      caught = err;
    }

    const target = String((caught as Prisma.PrismaClientKnownRequestError).meta?.target);
    expect(target).toContain("ticket_number");
    expect(target).not.toContain("client_request_id");
    // The decisive assertion: this error can NOT be routed to the replay branch.
    expect(isUniqueViolationOnField(caught, "client_request_id")).toBe(false);
    // While the permissive matcher still sends it to the ticket retry, unchanged.
    expect(isUniqueViolation(caught, "ticket_number")).toBe(true);
  });

  it("leaves unkeyed bookings alone — an older client keeps working", async () => {
    // Postgres treats NULLs as distinct, so the unique index must not stop a
    // requestor making several keyless bookings.
    const a = await book(requestor, {});
    const b = await book(requestor, {});
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("replays the original even after the booking has been dispatched", async () => {
    // The window that matters in prod: auto-dispatch runs inline on create, so
    // by the time the retry lands the trip may already be `assigned`. The
    // replay must still return it rather than book a second truck.
    const key = "dispatched-key-00000000001";
    const first = await book(requestor, { client_request_id: key });
    expect(first.status).toBe(201);

    const second = await book(requestor, { client_request_id: key });
    expect(second.body.id).toBe(first.body.id);
    // Whatever status dispatch left it in, the replay reports the same trip.
    expect(second.body.status).toBe(
      (await prisma.trip.findUnique({ where: { id: first.body.id } }))!.status
    );
    // Scoped to the key, not a bare count: a failed replay would have written a
    // SECOND row carrying this same key, which is exactly what this catches.
    expect(await prisma.trip.count({ where: { client_request_id: key } })).toBe(1);
  });
});
