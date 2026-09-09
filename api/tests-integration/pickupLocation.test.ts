import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  interplantRouteTypeId,
  ensureConsigneeInZone,
  futurePickupIso,
  userIdByPhone,
  approveTrip,
} from "./helpers/flow";

/**
 * Free-text pickup location for Customer/Supplier bookings (Mr. Teh, 9 Sep
 * 2026: "let them pick any location, same like we arrange to customer" — his
 * own R1 answer already said customer/supplier pickup "can be any place").
 * Display-only: never read by dispatch/rate logic, so no dispatch-path
 * coverage is needed here — only that the value round-trips through create
 * and edit correctly, and that the change-request routes (which never send
 * this field) can never wipe it. That second half is proven at the pure-unit
 * level in tests/tripEdit.test.ts ("the A19 safety test"); this file is the
 * "assert the guard is REACHED" half against the real routes.
 */
async function bookRaw(token: string, body: Record<string, unknown>) {
  return api().post("/api/v1/trips").set(auth(token)).send(body);
}

describe("pickup location — Customer/Supplier free text", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("POST /trips persists a submitted pickup location", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P1");
    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      pickup_location: "  Supplier Site A, Bayan Lepas  ",
    });
    expect(res.status).toBe(201);
    expect(res.body.pickup_location).toBe("Supplier Site A, Bayan Lepas"); // trimmed

    const trip = await prisma.trip.findUnique({ where: { id: res.body.id } });
    expect(trip?.pickup_location).toBe("Supplier Site A, Bayan Lepas");
  });

  it("POST /trips with no pickup_location stores null (today's default origin)", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P1");
    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.pickup_location).toBeNull();
  });

  it("PATCH /trips/:id updates the pickup location on a pending booking", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P1");
    const created = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      pickup_location: "Supplier Site A",
    });
    expect(created.status).toBe(201);

    const edited = await api()
      .patch(`/api/v1/trips/${created.body.id}`)
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: consignee.id }],
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
        pickup_location: "Supplier Site B",
      });
    expect(edited.status).toBe(200);
    expect(edited.body.pickup_location).toBe("Supplier Site B");
  });

  it("PATCH /trips/:id omitting pickup_location PRESERVES the existing value", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P1");
    const created = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      pickup_location: "Supplier Site A",
    });
    expect(created.status).toBe(201);

    // Edit something else entirely, WITHOUT sending pickup_location at all —
    // the exact shape the A19 change-request routes always send.
    const edited = await api()
      .patch(`/api/v1/trips/${created.body.id}`)
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: consignee.id }],
        cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
      });
    expect(edited.status).toBe(200);
    expect(edited.body.pickup_location).toBe("Supplier Site A");
  });

  it("Inter-Plant bookings ignore pickup_location entirely — the P1-P9 picker owns pickup there", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await interplantRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P2");
    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      // Sent anyway (a malicious/confused client) — the server accepts and
      // stores it (the field itself is not family-gated), but nothing in the
      // Inter-Plant UI ever sends it, and pickup there is governed entirely
      // by pickup_consignee_id (Item 3 multi-pickup), never this field.
      pickup_location: "Should not matter",
    });
    expect(res.status).toBe(201);
    expect(res.body.pickup_location).toBe("Should not matter");
  });

  describe("A19 change-request approval never wipes an assigned trip's pickup location", () => {
    const PND_PLATE = "PND 1888";

    beforeEach(() => {
      process.env.FEATURE_CHANGE_REQUESTS = "true";
    });
    afterEach(() => {
      delete process.env.FEATURE_CHANGE_REQUESTS;
    });

    it("approving an unrelated change (cargo qty) preserves the original pickup location", async () => {
      const requestor = await loginAs(REQUESTOR);
      const admin = await loginAs(ADMIN);
      const driverId = await userIdByPhone(DRIVER.phone);
      const rt = await firstRouteTypeId(requestor);
      const consignee = await ensureConsigneeInZone("P1");

      const created = await bookRaw(requestor, {
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: consignee.id }],
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
        pickup_location: "Supplier Site A",
      });
      expect(created.status).toBe(201);
      await approveTrip(admin, created.body.id, driverId, PND_PLATE);

      // The requestor's "Request Change" form does not carry a pickup-location
      // field (it is not wired into that screen) — this payload is exactly
      // what it actually sends: every editable field EXCEPT pickup_location.
      const cr = await api()
        .post(`/api/v1/trips/${created.body.id}/change-request`)
        .set(auth(requestor))
        .send({
          route_type_id: rt,
          pickup_datetime: futurePickupIso(),
          stops: [{ consignee_id: consignee.id }],
          cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
        });
      expect(cr.status, JSON.stringify(cr.body)).toBe(201);

      const approve = await api()
        .post(`/api/v1/trips/${created.body.id}/change-request/${cr.body.change_request.id}/approve`)
        .set(auth(admin))
        .send({});
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);

      const trip = await prisma.trip.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(trip.pickup_location).toBe("Supplier Site A");
    });
  });
});
