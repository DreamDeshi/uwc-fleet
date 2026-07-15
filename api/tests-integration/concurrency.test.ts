import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  approveRaw,
  startRaw,
  ensureConsigneeInZone,
  futurePickupIso,
  pickupDateKey,
  userIdByPhone,
  pallets,
  DRIVERS,
} from "./helpers/flow";

/**
 * CONCURRENCY integration (Phase 3) — the highest-risk paths, driven with
 * GENUINELY concurrent requests (Promise.all → two in-flight HTTP requests → two
 * Serializable transactions contending in Postgres). Each asserts the money- and
 * ops-critical invariant that survives real contention: exactly one writer wins,
 * the loser gets a 4xx (the isSerializationConflict → 409 / status-guarded-CAS
 * path), and the DB is never left double-assigned, double-started, or corrupt.
 *
 * These are the only automated tests that exercise that path under real
 * contention — everything else models it with in-memory CAS fakes.
 */

const PLX_PLATE = DRIVERS.PLX.plate;
const PND_PLATE = DRIVERS.PND.plate;

const okCount = (rs: { status: number }[]) => rs.filter((r) => r.status === 200).length;

describe("CONCURRENCY integration — Serializable → 409 under real contention", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("double-assign the SAME trip: two concurrent approves → one wins, one 409", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const [a, b] = await Promise.all([
      approveRaw(admin, trip.id, plx, PLX_PLATE, true),
      approveRaw(admin, trip.id, pnd, PND_PLATE, true),
    ]);

    expect(okCount([a, b])).toBe(1);
    const loser = [a, b].find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("CONCURRENT_ASSIGNMENT");

    // Assigned to exactly ONE of the two drivers — never both, never neither.
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.status).toBe("assigned");
    expect([plx, pnd]).toContain(after.driver_id);
  });

  it("one-active-trip: a driver starting two held trips at once → one 200, one 409", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);

    // A driver may HOLD several assigned trips (force past the same-pickup conflict)…
    const t1 = await bookTrip(requestor, ["P1"], rt);
    const t2 = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, t1.id, plx, PLX_PLATE);
    await approveTrip(admin, t2.id, plx, PLX_PLATE);

    // …but may be OUT on only ONE at a time.
    const [a, b] = await Promise.all([startRaw(driver, t1.id), startRaw(driver, t2.id)]);

    expect(okCount([a, b])).toBe(1);
    const loser = [a, b].find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(["DRIVER_ALREADY_ON_TRIP", "TRIP_STATE_CHANGED"]).toContain(loser.body.error.code);

    const inProgress = await prisma.trip.count({ where: { driver_id: plx, status: "in_progress" } });
    expect(inProgress).toBe(1);
  });

  it("duplicate start of the SAME trip → one 200, one 409 TRIP_STATE_CHANGED", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const t = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, t.id, plx, PLX_PLATE);

    const [a, b] = await Promise.all([startRaw(driver, t.id), startRaw(driver, t.id)]);

    expect(okCount([a, b])).toBe(1);
    const loser = [a, b].find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("TRIP_STATE_CHANGED");
    expect((await prisma.trip.findUnique({ where: { id: t.id } }))!.status).toBe("in_progress");
  });

  it("reassign vs start on the same assigned trip → exactly one wins, state stays consistent", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const pnd = await userIdByPhone(DRIVERS.PND.phone);
    const t = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, t.id, plx, PLX_PLATE); // assigned to PLX (this driver)

    const [reassign, start] = await Promise.all([
      api()
        .patch(`/api/v1/trips/${t.id}/reassign`)
        .set(auth(admin))
        .send({ driver_id: pnd, truck_plate: PND_PLATE, force: true }),
      startRaw(driver, t.id),
    ]);

    expect(okCount([reassign, start])).toBe(1);
    const after = (await prisma.trip.findUnique({ where: { id: t.id } }))!;
    if (start.status === 200) {
      // Start won: rolling under the ORIGINAL driver; reassign lost.
      expect(after.status).toBe("in_progress");
      expect(after.driver_id).toBe(plx);
      expect(reassign.status).toBe(409);
    } else {
      // Reassign won: handed to the new driver, not started; start lost.
      expect(after.status).toBe("assigned");
      expect(after.driver_id).toBe(pnd);
      expect(start.status).toBe(409);
    }
  });

  it("leave granted vs assigning the same driver → no crash, consistent outcome", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const trip = await bookTrip(requestor, ["A2"], rt, pallets(2)); // A2 → PLX is the only fit
    const dateKey = pickupDateKey();

    const [leaveRes, approveRes] = await Promise.all([
      api().post("/api/v1/leaves").set(auth(admin)).send({ driver_id: plx, start_date: dateKey, end_date: dateKey }),
      approveRaw(admin, trip.id, plx, PLX_PLATE, true),
    ]);

    // The leave is always granted; the assignment either slipped through before
    // the leave was visible, or was blocked — but never crashed or corrupted.
    expect(leaveRes.status).toBe(201);
    expect([200, 409]).toContain(approveRes.status);

    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    if (approveRes.status === 200) {
      expect(after.status).toBe("assigned");
      expect(after.driver_id).toBe(plx);
    } else {
      expect(after.status).toBe("pending");
      expect(["DRIVER_ON_LEAVE", "CONCURRENT_ASSIGNMENT"]).toContain(approveRes.body.error.code);
    }
    expect(await prisma.driverLeave.count({ where: { driver_id: plx } })).toBeGreaterThanOrEqual(1);
  });

  it("simultaneous bookings never produce a DUPLICATE ticket number (uniqueness holds under contention)", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const c = await ensureConsigneeInZone("P1");
    const N = 8; // well past the first-attempt collision — stresses the invariant

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        api()
          .post("/api/v1/trips")
          .set(auth(requestor))
          .send({
            route_type_id: rt,
            pickup_datetime: futurePickupIso(),
            stops: [{ consignee_id: c.id }],
            cargo_details: pallets(1),
          })
      )
    );

    // The CORRECTNESS invariant, always true — a @unique ticket_number can never
    // be violated: no two SUCCESSFUL bookings ever share a ticket number.
    const successes = results.filter((r) => r.status === 201);
    const tickets = successes.map((r) => r.body.ticket_number as string);
    expect(new Set(tickets).size).toBe(tickets.length);

    // The DB agrees — exactly one trip per success, every ticket number distinct.
    const dbTickets = (await prisma.trip.findMany({ select: { ticket_number: true } })).map(
      (t) => t.ticket_number
    );
    expect(new Set(dbTickets).size).toBe(dbTickets.length);
    expect(dbTickets.length).toBe(successes.length);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // ROBUSTNESS (the former flagged 500): retries now disperse with jitter
    // (ticketSequence) and an exhausted budget maps to a retryable 409
    // TICKET_CONFLICT — a booking burst must NEVER surface a raw-P2002 500.
    const failures = results.filter((r) => r.status !== 201);
    for (const f of failures) {
      expect(f.status).toBe(409);
      expect(f.body.error.code).toBe("TICKET_CONFLICT");
    }
  });

  it("cancel vs approve on a pending trip → exactly one wins, no cancelled-with-driver", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const [cancel, approve] = await Promise.all([
      api().patch(`/api/v1/trips/${trip.id}/cancel`).set(auth(requestor)),
      approveRaw(admin, trip.id, plx, PLX_PLATE, true),
    ]);

    expect(okCount([cancel, approve])).toBe(1);
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    if (approve.status === 200) {
      expect(after.status).toBe("assigned");
      expect([400, 409]).toContain(cancel.status);
    } else {
      // Cancel won: cancelled trip must never keep a driver/truck attached.
      expect(after.status).toBe("cancelled");
      expect(after.driver_id).toBeNull();
      expect(after.truck_plate).toBeNull();
      expect(approve.status).toBe(409);
    }
  });

  it("reject vs approve on a pending trip → exactly one wins, consistent state", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const [reject, approve] = await Promise.all([
      api().patch(`/api/v1/trips/${trip.id}/reject`).set(auth(admin)).send({}),
      approveRaw(admin, trip.id, plx, PLX_PLATE, true),
    ]);

    expect(okCount([reject, approve])).toBe(1);
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    if (approve.status === 200) {
      expect(after.status).toBe("assigned");
      expect(reject.status).toBe(409);
    } else {
      expect(after.status).toBe("rejected");
      expect(after.driver_id).toBeNull();
      expect(approve.status).toBe(409);
    }
  });
});
