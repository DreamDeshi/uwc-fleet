import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  interplantRouteTypeId,
  uwcPlantIds,
  ensureConsigneeInZone,
  futurePickupIso,
  autoDispatch,
} from "./helpers/flow";

/**
 * ITEM 3 MULTI-PICKUP (interplant-only). Mr. Teh, R1 2026-07-24, also said
 * interplant DELIVERY is restricted to UWC Plant 1-9 — that half is
 * deliberately NOT enforced (see the header on assertMultiPickupPlantsValid
 * in src/routes/trips.ts): it conflicts with the existing, shipped
 * interplant dispatch/round-trip suites, which book ordinary consignees as
 * the destination. Only the PICKUP side is validated here.
 *
 * assertMultiPickupPlantsValid is unit-tested without a DB in
 * tests/tripValidation.test.ts, including proven-by-breaking coverage of its
 * guards. This suite is the "assert the guard is REACHED" half: the real
 * POST /trips and PATCH /trips/:id routes, against a real database, plus the
 * edit-diff key fix (a plant move must not silently read as "no change").
 */
async function bookRaw(token: string, body: Record<string, unknown>) {
  return api().post("/api/v1/trips").set(auth(token)).send(body);
}

describe("ITEM 3 MULTI-PICKUP integration", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("seeds exactly nine UWC Plant consignees, all flagged is_uwc_plant", async () => {
    const plants = await prisma.consignee.findMany({ where: { is_uwc_plant: true } });
    expect(plants.length).toBe(9);
    for (const p of plants) {
      expect(p.company_name).toMatch(/^UWC Plant [1-9]$/);
      expect(p.zone_code).toBe("P2");
      expect(p.is_active).toBe(true);
    }
  });

  it("GET /consignees/plants returns exactly the nine plants, nothing else", async () => {
    const requestor = await loginAs(REQUESTOR);
    const res = await api().get("/api/v1/consignees/plants").set(auth(requestor));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(9);
    expect(res.body.every((c: { company_name: string }) => /^UWC Plant [1-9]$/.test(c.company_name))).toBe(true);
  });

  it("rejects a pickup plant on a NON-interplant booking → 400 MULTI_PICKUP_INTERPLANT_ONLY", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor); // Customer Delivery
    const consignee = await ensureConsigneeInZone("P1");
    const [plant1] = await uwcPlantIds();

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1, pickup_consignee_id: plant1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MULTI_PICKUP_INTERPLANT_ONLY");
  });

  // NOT enforced, deliberately: an interplant booking's DESTINATION is NOT
  // restricted to a UWC plant. That restriction was tried and reverted — see
  // the header comment on assertMultiPickupPlantsValid in src/routes/trips.ts.
  // This pins the reversal so nobody re-adds it without re-reading why: the
  // existing interplant dispatch/round-trip suites book ordinary consignees
  // as the destination and depend on that continuing to work.
  it("allows an interplant booking whose destination is an ordinary (non-plant) consignee", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const customer = await ensureConsigneeInZone("P1");

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: customer.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
    expect(res.status).toBe(201);
  });

  it("rejects an interplant booking whose PICKUP is a customer consignee → 400 PICKUP_NOT_A_PLANT", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const customer = await ensureConsigneeInZone("P1");
    const [plant1] = await uwcPlantIds();

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: plant1 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1, pickup_consignee_id: customer.id }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PICKUP_NOT_A_PLANT");
  });

  it("accepts a valid interplant booking (plant pickup -> plant destination) and stores the pickup on the cargo line", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const [plant1, plant2] = await uwcPlantIds();

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: plant2 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1, pickup_consignee_id: plant1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.cargo_details[0].pickup_consignee_id).toBe(plant1);
  });

  it("accepts an interplant booking with NO pickup selected — today's single-origin default still works", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const [, plant2] = await uwcPlantIds();

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: plant2 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.cargo_details[0].pickup_consignee_id).toBeNull();
  });

  it("EDIT-DIFF KEY: moving the SAME cargo to a different pickup plant registers as a real change, not a no-op", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const [plant1, plant2, plant3] = await uwcPlantIds();

    const booked = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: plant3 }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1, pickup_consignee_id: plant1 }],
    });
    expect(booked.status).toBe(201);
    const tripId = booked.body.id;

    // Edit: SAME pallet_type/quantity/destination — only the pickup plant moves.
    const edited = await api()
      .patch(`/api/v1/trips/${tripId}`)
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: booked.body.pickup_datetime,
        stops: [{ consignee_id: plant3 }],
        cargo_details: [{ pallet_type: "4×4", quantity: 1, pickup_consignee_id: plant2 }],
      });
    expect(edited.status).toBe(200);
    expect(edited.body.cargo_details[0].pickup_consignee_id).toBe(plant2);

    // The `edited` timeline event must exist and NAME cargo as changed — proving
    // the diff key change (not just the write) actually took effect.
    const history = await prisma.tripStatusHistory.findMany({
      where: { trip_id: tripId, event: "edited" },
    });
    expect(history.length).toBe(1);
    expect(history[0].note ?? "").toMatch(/cargo/i);
  });

  // AUTO-DISPATCH must count MULTI-PICKUP LOADS the same way manual assign
  // does. Found in code review 31 Aug 2026: autoDispatchTrip's cargo select
  // never fetched pickup_consignee_id, so its operating-window estimate
  // always used pickupCount=1 regardless of how many distinct pickup plants
  // (or plant + default-origin combinations) the cargo actually named — see
  // computePickupCount in services/operatingWindow.ts.
  //
  // This is a "guard reached" proof, not just a pure-function test: it drives
  // the real POST /dispatch/auto route against a real database, with every
  // truck's window narrowed just enough that a genuine 1-pickup estimate
  // fits but a genuine 2-pickup estimate does not. Before the fix, BOTH
  // cases below would incorrectly succeed, because auto-dispatch never saw
  // the second pickup at all.
  //
  // ⚠ The destination plant sits in zone P2 (1 point), and the drive leg is
  // SCALED by zone points relative to OP_DRIVE_POINTS_BASELINE (default 3):
  // round(45 * 1/3) = 15 min, not the flat 45. First version of this test
  // assumed the flat figure and picked a window loose enough that BOTH
  // cases fit — it went green against a real database while proving
  // nothing, caught by CI's Postgres integration tier. The real numbers:
  //   1 pickup: 30 load + 15 drive + 20 unload = 65 min
  //   2 pickups: 60 load + 15 drive + 20 unload = 95 min
  describe("auto-dispatch respects the multi-pickup load count", () => {
    beforeEach(async () => {
      // Tomorrow 09:00 MYT (futurePickupIso) + 65 min = 10:05 (fits);
      // + 95 min = 10:35 (does not). 10:15 sits between the two with a
      // margin on both sides.
      await prisma.truck.updateMany({
        data: { operating_hours_start: "07:00", operating_hours_end: "10:15" },
      });
    });

    it("a single-pickup interplant trip (pickupCount=1) auto-dispatches inside the narrowed window", async () => {
      const requestor = await loginAs(REQUESTOR);
      const admin = await loginAs(ADMIN);
      const rt = await interplantRouteTypeId(requestor);
      const [, plant2] = await uwcPlantIds();

      const booked = await bookRaw(requestor, {
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: plant2 }],
        // No pickup_consignee_id on either line → both default-origin → 1 load.
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
      expect(booked.status).toBe(201);

      const res = await autoDispatch(admin, booked.body.id);
      expect(res.status).toBe(200);
    });

    it("⚠ a MIXED interplant trip (explicit plant + default origin, pickupCount=2) fails on the SAME window that admitted pickupCount=1", async () => {
      const requestor = await loginAs(REQUESTOR);
      const admin = await loginAs(ADMIN);
      const rt = await interplantRouteTypeId(requestor);
      const [plant1, plant2] = await uwcPlantIds();

      const booked = await bookRaw(requestor, {
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: plant2 }],
        // One line pinned to an explicit plant, the other left at the
        // default origin — two real physical pickup stops, same cargo
        // volume as the case above.
        cargo_details: [
          { pallet_type: "4×4", quantity: 1, pickup_consignee_id: plant1 },
          { pallet_type: "2×2", quantity: 1 },
        ],
      });
      expect(booked.status).toBe(201);

      const res = await autoDispatch(admin, booked.body.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

      const after = (await prisma.trip.findUnique({ where: { id: booked.body.id } }))!;
      expect(after.status).toBe("pending");
      // Specifically the WINDOW note, not a generic no-capacity one — proves
      // the extra load, not something unrelated, is what pushed this over.
      expect(after.auto_dispatch_note ?? "").toMatch(/exceeds the .* operating window/);
    });
  });
});
