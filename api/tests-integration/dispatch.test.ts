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
 * The seeded CUSTOMER pool since the 28 Jul 2026 revision: PND 1888 (14 — the
 * A1/A2 primary, Azmi's move), PSA 5292 (14), PRJ/PQL/PPE 1804 (8),
 * PRH 5292 (2, covers ALL zones — its old A1/A2 small-load cap is REMOVED,
 * R3 A3). PLX 2406 (16) and PPE 2406 are INTERPLANT — never auto-dispatched
 * for customer work, so the pool's largest truck is 14 and the 15–16-pallet
 * band falls to manual by design (owner-approved, R3 A7). KL is a long-haul
 * zone no truck covers.
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

    it("the 15–16-pallet band is ACCEPTED at booking but auto-unfulfillable → manual (28 Jul revision)", async () => {
      // PLX (16) left the customer pool for interplant, so the pool max is 14.
      // The booking is still accepted (CARGO_EXCEEDS_FLEET keys on the WHOLE
      // fleet incl. PLX) and falls to needs-attention for the admin's
      // PLX-as-backup / external-lorry call — the owner-approved design (R3 A7).
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P1"], rt, pallets(16)); // accepted: 201
      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("pending");
      expect(after.truck_plate).toBeNull(); // never the interplant PLX
      expect(after.auto_dispatch_failed).toBe(true);
      expect(after.auto_dispatch_note).toBe("No available truck has capacity for this order.");
    });

    it("the interplant shuttles are NEVER auto-assigned, even when idle and fitting", async () => {
      // An 11-pallet P2 order fits PLX (16) and both 14s. PLX is idle — but it
      // is interplant (email pt 1: "remove it from auto dispatch to customer /
      // supplier delivery"), so a 14 must win.
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["P2"], rt, pallets(11));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.truck_plate).not.toBe("PLX 2406");
      expect(after.truck_plate).not.toBe("PPE 2406");
      expect(await assignedTruckMax(trip.id)).toBe(14);
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

  // ── Long-haul zone (KL) ───────────────────────────────────────────────────
  describe("long-haul zone (KL)", () => {
    it.each(["KL"])(
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
        // The zone's points snapshotted at assignment — proves KL resolves
        // to 8 (not a silent 1pt / ZONE_POINTS_MISSING).
        expect(after.stops[0].zone_points).toBe(8);
      }
    );
  });

  // ── Candidate filtering (A1/A2 primary + leave + roadworthy) ──────────────
  describe("candidate filtering", () => {
    it("a healthy A2 order goes to the primary PND 1888 (Azmi's truck since 28 Jul)", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PND 1888");
    });

    it("REGRESSION (R3 A3): with PND's driver on leave, a 2-pallet A2 order goes to PRH 5292", async () => {
      // No named backup ("You can assign any … depend cargo size", R3 A2) and
      // the strictly-under-2 small-load cap died with the removed rule — PRH
      // covers A2 and a 2-pallet load fits its physical max exactly.
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const pndDriver = await userIdByPhone(DRIVERS.PND.phone);
      await prisma.driverLeave.create({
        data: { driver_id: pndDriver, start_date: pickupDateKey(), end_date: pickupDateKey() },
      });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(2));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PRH 5292");
    });

    it("with PND 1888 unroadworthy (insurance expired), a 9-pallet A2 order falls to PSA 5292", async () => {
      // 9 pallets keeps PRH/the 8s out, so the only remaining fit is the other
      // 14 — proving the roadworthiness exclusion opens A1/A2 to normal ranking.
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      await prisma.truck.update({
        where: { plate: "PND 1888" },
        data: { insurance_expiry: new Date("2020-01-01T00:00:00Z") },
      });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(9));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.truck_plate).toBe("PSA 5292");
    });

    it("an A2 order too big for the whole customer pool is flagged, never given to interplant PLX", async () => {
      // 15 pallets: PLX (16) is idle and would fit — but it is interplant.
      // Capacity of the CUSTOMER pool (max 14), not eligibility, fails this.
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(15));
      const res = await autoDispatch(admin, trip.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("pending");
      expect(after.truck_plate).toBeNull();
      expect(after.auto_dispatch_failed).toBe(true);
      expect(after.auto_dispatch_note).toBe("No available truck has capacity for this order.");
    });

    it("with BOTH 14s out, a 3-pallet A2 order falls to a 17.5ft lorry (PRH too small)", async () => {
      const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
      const rt = await firstRouteTypeId(requestor);
      const [pndDriver, psaDriver] = await Promise.all([
        userIdByPhone(DRIVERS.PND.phone),
        userIdByPhone(DRIVERS.PSA.phone),
      ]);
      await prisma.driverLeave.createMany({
        data: [pndDriver, psaDriver].map((driver_id) => ({
          driver_id,
          start_date: pickupDateKey(),
          end_date: pickupDateKey(),
        })),
      });
      const trip = await bookTrip(requestor, ["A2"], rt, pallets(3));
      expect((await autoDispatch(admin, trip.id)).status).toBe(200);

      const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
      expect(after.status).toBe("assigned");
      expect(after.truck_plate).not.toBe("PRH 5292"); // 3 > its physical max of 2
      expect(await assignedTruckMax(trip.id)).toBe(8);
    });
  });
});
