import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  autoDispatch,
  ensureConsigneeInZone,
  futurePickupIso,
  pickupDateKey,
  userIdByPhone,
  pallets,
  DRIVERS,
} from "./helpers/flow";

/**
 * DISPATCH integration (Phase 2) — the auto-dispatch engine (autoDispatchTrip)
 * exercised through the real HTTP endpoint + Postgres.
 *
 * The seeded fleet (all cover the Penang/Kedah P-zones): PLX 2406 (16, the only
 * A1/A2 primary), PND 1888 (14, A1/A2 backup), PRJ/PQL/PPE 5292 (8), PRH 5292
 * (2). KL/JH/SL are long-haul zones no truck covers.
 */

async function assignedTruckMax(tripId: string): Promise<number> {
  const t = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!t?.truck_plate) throw new Error(`trip ${tripId} is not assigned`);
  const truck = await prisma.truck.findUnique({ where: { plate: t.truck_plate } });
  return truck!.max_pallets;
}

describe("DISPATCH integration — auto-dispatch engine", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── The cargo-estimate fix's ENGINE consequence (commit ac202e3) ──────────
  describe("unsized cargo → manual, not the smallest truck", () => {
    it("a carton line with NO estimate leaves the booking pending + flagged (never auto-assigns PRH)", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, [{ pallet_type: "carton", quantity: 1 }]);

      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("pending");
      expect(after.driver_id).toBeNull();
      expect(after.truck_plate).toBeNull(); // crucially NOT the 2-pallet PRH
      expect(after.auto_dispatch_failed).toBe(true);
      expect(after.auto_dispatch_note).toBe("Cargo size not specified — manual assignment required.");
    });

    it("a carton line WITH an estimate auto-dispatches, sized on the estimate", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, [
        { pallet_type: "carton", quantity: 1, estimated_pallets: 3 },
      ]);

      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(200);

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("assigned");
      expect(after.driver_id).not.toBeNull();
      // Sized at 3 → the smallest truck that fits is an 8-pallet lorry, not PRH(2).
      expect(await assignedTruckMax(trip.id)).toBe(8);
      expect(after.truck_plate).not.toBe("PRH 5292");
    });
  });

  // ── Capacity boundaries ───────────────────────────────────────────────────
  describe("capacity boundaries (Best-Fit Decreasing)", () => {
    it("an order at an 8-pallet truck's exact capacity takes an 8-pallet truck", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, pallets(8));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect(await assignedTruckMax(trip.id)).toBe(8);
    });

    it("one pallet over the 8s bumps up to the 14-pallet truck", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, pallets(9));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect(await assignedTruckMax(trip.id)).toBe(14);
    });

    it("an order at the fleet's max fits only the largest truck (16 → PLX 2406)", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, pallets(16));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.truck_plate).toBe("PLX 2406");
    });

    it("an order over the fleet's largest truck is rejected at booking (CARGO_EXCEEDS_FLEET)", async () => {
      const requestor = await loginAs(REQUESTOR);
      const rt = await firstRouteTypeId(requestor);
      const c = await ensureConsigneeInZone("P1");
      const res = await api()
        .post("/api/v1/trips")
        .set(auth(requestor))
        .send({
          route_type_id: rt,
          pickup_datetime: futurePickupIso(),
          stops: [{ consignee_id: c.id }],
          cargo_details: pallets(17),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CARGO_EXCEEDS_FLEET");
    });
  });

  // ── New long-haul zones (KL / JH / SL) ────────────────────────────────────
  describe("new long-haul zones (KL / JH / SL)", () => {
    it.each(["KL", "JH", "SL"])(
      "dispatches a %s order (no truck covers it) and prices the drop at 8 points",
      async (zone) => {
        const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
        const rt = await firstRouteTypeId(requestor);
        const trip = await bookTrip(requestor, [zone], rt);
        expect((await autoDispatch(admin, trip.id)).status).toBe(200);

        const after = (await prisma.trip.findUnique({
          where: { id: trip.id },
          include: { stops: true },
        }))!;
        expect(after.status).toBe("assigned");
        expect(after.driver_id).not.toBeNull();
        // The zone's points snapshotted at assignment — proves KL/JH/SL resolve
        // to 8 (not a silent 1pt / ZONE_POINTS_MISSING).
        expect(after.stops[0].zone_points).toBe(8);
      }
    );
  });

  // ── Candidate filtering (A1/A2 gate + leave + roadworthy) ─────────────────
  describe("candidate filtering", () => {
    it("a healthy A2 order goes to the primary PLX 2406", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PLX 2406");
    });

    it("with PLX 2406's driver on leave, an A2 order falls to the PND 1888 backup", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const plxDriver = await userIdByPhone(DRIVERS.PLX.phone);
      await prisma.driverLeave.create({
        data: { driver_id: plxDriver, start_date: pickupDateKey(), end_date: pickupDateKey() },
      });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PND 1888");
    });

    it("with PLX 2406 unroadworthy (insurance expired), an A2 order falls to PND 1888", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      await prisma.truck.update({
        where: { plate: "PLX 2406" },
        data: { insurance_expiry: new Date("2020-01-01T00:00:00Z") },
      });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PND 1888");
    });

    it("when leave removes the ONLY truck that can fit + serve A2, the booking is flagged", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const plxDriver = await userIdByPhone(DRIVERS.PLX.phone);
      await prisma.driverLeave.create({
        data: { driver_id: plxDriver, start_date: pickupDateKey(), end_date: pickupDateKey() },
      });
      // 15 pallets in A2: only PLX (16) both fits AND may serve A2. With PLX out,
      // PND (14) can't fit 15 and PRH is barred from A2 → nobody.
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(15));
      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("pending");
      expect(after.auto_dispatch_failed).toBe(true);
      expect(after.auto_dispatch_note).toBe("No available truck has capacity for this order.");
    });
  });
});
