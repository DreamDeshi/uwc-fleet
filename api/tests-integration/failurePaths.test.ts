import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  approveRaw,
  startTrip,
  arriveAndDeliver,
  deliverRaw,
  autoDispatch,
  futurePickupIso,
  userIdByPhone,
  pallets,
  num,
  DRIVERS,
} from "./helpers/flow";

/**
 * FAILURE PATHS (Phase 4) — the edge/error flows exercised through the real
 * HTTP API + Postgres.
 */

const PLX_PLATE = DRIVERS.PLX.plate;
const EXPIRED = new Date("2020-01-01T00:00:00Z");

async function actors() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  const rt = await firstRouteTypeId(requestor);
  const plx = await userIdByPhone(DRIVERS.PLX.phone);
  return { requestor, admin, driver, rt, plx };
}

describe("FAILURE PATHS integration", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── Duplicate submission → paid once ──────────────────────────────────────
  describe("duplicate submission (no double-pay)", () => {
    it("re-delivering an already-delivered stop is rejected and never re-pays", async () => {
      const { requestor, admin, driver, rt, plx } = await actors();
      const trip = await bookTrip(requestor, ["A2"], rt);
      await approveTrip(admin, trip.id, plx, PLX_PLATE);
      await startTrip(driver, trip.id);
      await arriveAndDeliver(driver, trip.id, trip.stops[0].id); // → completed + paid

      const paid = num((await prisma.trip.findUnique({ where: { id: trip.id } }))!.incentive_earned);
      expect(paid).toBeGreaterThan(0);

      // Replay the delivery (what the offline outbox would do on a stale queue).
      const again = await deliverRaw(driver, trip.id, trip.stops[0].id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("TRIP_NOT_ACTIVE"); // trip already completed

      // Pay is unchanged — the finalize write-once held.
      const after = num((await prisma.trip.findUnique({ where: { id: trip.id } }))!.incentive_earned);
      expect(after).toBe(paid);
    });
  });

  // ── Expired-doc enforcement ───────────────────────────────────────────────
  describe("expired-document enforcement", () => {
    it("expired ROAD TAX is a hard block at manual approve (even with force)", async () => {
      const { requestor, admin, rt, plx } = await actors();
      await prisma.truck.update({ where: { plate: PLX_PLATE }, data: { road_tax_expiry: EXPIRED } });
      const trip = await bookTrip(requestor, ["P1"], rt);
      const res = await approveRaw(admin, trip.id, plx, PLX_PLATE, true); // force ignored
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("TRUCK_UNROADWORTHY");
    });

    it("an expired PERMIT excludes a truck from AUTO dispatch (auto has no force)", async () => {
      const { requestor, admin, rt } = await actors();
      // Permit is only a WARNING on manual approve, but auto-dispatch excludes it
      // outright — so an A2 order falls from the primary PLX to the PND backup.
      await prisma.truck.update({ where: { plate: PLX_PLATE }, data: { permit_expiry: EXPIRED } });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PND 1888");
    });
  });

  // ── Consignee correction lock + dedupe ────────────────────────────────────
  describe("consignee correction lock + dedupe", () => {
    async function makeConsignee(name: string, zone = "P1") {
      return prisma.consignee.create({
        data: { company_name: name, zone_code: zone, is_active: true },
      });
    }

    it("self-adding a SIMILAR consignee warns (409 SIMILAR_EXISTS); force creates it", async () => {
      const requestor = await loginAs(REQUESTOR);
      await makeConsignee("Acme Widgets Sdn Bhd");

      const warn = await api()
        .post("/api/v1/consignees")
        .set(auth(requestor))
        .send({ company_name: "Acme Widgets", zone_code: "P1" });
      expect(warn.status).toBe(409);
      expect(warn.body.error.code).toBe("SIMILAR_EXISTS");
      // errorHandler spreads ApiError.details into `error`, so candidates sit here.
      expect(warn.body.error.candidates.length).toBeGreaterThan(0);

      const forced = await api()
        .post("/api/v1/consignees")
        .set(auth(requestor))
        .send({ company_name: "Acme Widgets", zone_code: "P1", force: true });
      expect(forced.status).toBe(201);
    });

    it("RENAMING into a near-duplicate warns (409 SIMILAR_EXISTS); force renames", async () => {
      const admin = await loginAs(ADMIN);
      await makeConsignee("Beta Logistics Sdn Bhd");
      const b = await makeConsignee("Gamma Freight Sdn Bhd");

      const warn = await api()
        .patch(`/api/v1/consignees/${b.id}`)
        .set(auth(admin))
        .send({ company_name: "Beta Logistics" });
      expect(warn.status).toBe(409);
      expect(warn.body.error.code).toBe("SIMILAR_EXISTS");

      const forced = await api()
        .patch(`/api/v1/consignees/${b.id}`)
        .set(auth(admin))
        .send({ company_name: "Beta Logistics", force: true });
      expect(forced.status).toBe(200);
      expect(forced.body.company_name).toBe("Beta Logistics");
    });

    it("deactivating a consignee with a LIVE booking warns (409 CONSIGNEE_IN_USE); force deactivates", async () => {
      const { requestor, admin, rt } = await actors();
      const c = await makeConsignee("Delta Depot Sdn Bhd");
      // A live (pending) booking still routing to this consignee.
      await api()
        .post("/api/v1/trips")
        .set(auth(requestor))
        .send({
          route_type_id: rt,
          pickup_datetime: futurePickupIso(),
          stops: [{ consignee_id: c.id }],
          cargo_details: pallets(1),
        });

      const warn = await api().patch(`/api/v1/consignees/${c.id}`).set(auth(admin)).send({ is_active: false });
      expect(warn.status).toBe(409);
      expect(warn.body.error.code).toBe("CONSIGNEE_IN_USE");
      expect(warn.body.error.count).toBe(1);

      const forced = await api()
        .patch(`/api/v1/consignees/${c.id}`)
        .set(auth(admin))
        .send({ is_active: false, force: true });
      expect(forced.status).toBe(200);
      expect(forced.body.is_active).toBe(false);
    });

    it("an INACTIVE consignee is unbookable (400 CONSIGNEE_NOT_FOUND)", async () => {
      const { requestor, rt } = await actors();
      const c = await prisma.consignee.create({
        data: { company_name: "Epsilon Stores Sdn Bhd", zone_code: "P1", is_active: false },
      });
      const res = await api()
        .post("/api/v1/trips")
        .set(auth(requestor))
        .send({
          route_type_id: rt,
          pickup_datetime: futurePickupIso(),
          stops: [{ consignee_id: c.id }],
          cargo_details: pallets(1),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CONSIGNEE_NOT_FOUND");
    });
  });

  // ── No valid truck ────────────────────────────────────────────────────────
  describe("no valid truck", () => {
    it("when every truck is unavailable, auto-dispatch fails + flags the booking", async () => {
      const { requestor, admin, rt } = await actors();
      await prisma.truck.updateMany({ data: { is_available: false } }); // restored by resetDb
      const trip = await bookTrip(requestor, ["P1"], rt);

      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("pending");
      expect(after.auto_dispatch_failed).toBe(true);
      expect(after.auto_dispatch_note).toBe("No available truck has capacity for this order.");
    });
  });

  // ── Attention board — the untested 3rd case ───────────────────────────────
  describe("attention board — completed trip with NULL incentive", () => {
    it("surfaces internal completed trips with no pay; excludes paid + external ones", async () => {
      const admin = await loginAs(ADMIN);
      const requestorId = await userIdByPhone(REQUESTOR.phone);
      const plx = await userIdByPhone(DRIVERS.PLX.phone);
      const rtRow = (await prisma.routeType.findFirst())!;
      const base = {
        requestor_id: requestorId,
        route_type_id: rtRow.id,
        pickup_datetime: new Date("2026-07-01T01:00:00Z"),
        status: "completed" as const,
      };

      const anomaly = await prisma.trip.create({
        data: { ...base, ticket_number: "ANOM-NULL", driver_id: plx, truck_plate: PLX_PLATE, incentive_earned: null },
      });
      await prisma.trip.create({
        data: { ...base, ticket_number: "ANOM-PAID", driver_id: plx, truck_plate: PLX_PLATE, incentive_earned: 44 },
      });
      await prisma.trip.create({
        data: { ...base, ticket_number: "ANOM-EXT", is_external: true, incentive_earned: null },
      });

      const res = await api().get("/api/v1/reports/attention").set(auth(admin));
      expect(res.status).toBe(200);
      const tickets = res.body.completed_null_incentive.map((t: { ticket_number: string }) => t.ticket_number);
      expect(tickets).toContain("ANOM-NULL");
      expect(tickets).not.toContain("ANOM-PAID"); // has pay
      expect(tickets).not.toContain("ANOM-EXT"); // external carries no incentive by design
      expect(res.body.completed_null_incentive).toHaveLength(1);
      expect(res.body.completed_null_incentive[0].id).toBe(anomaly.id);
    });
  });
});
