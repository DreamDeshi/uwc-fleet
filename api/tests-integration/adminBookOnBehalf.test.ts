import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, ensureConsigneeInZone, futurePickupIso, userIdByPhone } from "./helpers/flow";

/**
 * BL6 — an admin booking on a requestor's behalf must attribute the trip to
 * that requestor, not to the admin's own account. Found 17 Aug 2026
 * rebuilding the SDG demo: five admin-placed bookings left the real
 * requestor's own list EMPTY (`GET /trips` as the requestor returned 0) — the
 * trip existed and dispatched correctly, but the person it was booked for had
 * no way to see it in the app at all. `POST /trips` already allowed an admin
 * caller (`requireRole("requestor", "admin")`); it simply always stamped
 * `requestor_id: req.user!.id`, which is only ever correct for a requestor
 * booking themselves.
 */
async function bookRaw(token: string, body: Record<string, unknown>) {
  return api().post("/api/v1/trips").set(auth(token)).send(body);
}

describe("BL6 — admin booking on a requestor's behalf", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("an admin-supplied requestor_id attributes the trip to that requestor, not the admin", async () => {
    const admin = await loginAs(ADMIN);
    const requestor = await loginAs(REQUESTOR);
    const requestorId = await userIdByPhone(REQUESTOR.phone);
    const adminId = await userIdByPhone(ADMIN.phone);
    const rt = await firstRouteTypeId(admin);
    const consignee = await ensureConsigneeInZone("P1");

    const res = await bookRaw(admin, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      requestor_id: requestorId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(trip.requestor_id).toBe(requestorId);
    expect(trip.requestor_id).not.toBe(adminId);

    // The whole point: the real requestor's own list must show it.
    const mine = await api().get("/api/v1/trips").set(auth(requestor));
    expect(mine.body.some((t: { id: string }) => t.id === res.body.id)).toBe(true);
  });

  it("an admin booking with no requestor_id still defaults to themselves (unchanged behaviour)", async () => {
    const admin = await loginAs(ADMIN);
    const adminId = await userIdByPhone(ADMIN.phone);
    const rt = await firstRouteTypeId(admin);
    const consignee = await ensureConsigneeInZone("P1");

    const res = await bookRaw(admin, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(trip.requestor_id).toBe(adminId);
  });

  it("rejects a requestor_id that is not a real requestor (a driver's id, say)", async () => {
    const admin = await loginAs(ADMIN);
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(admin);
    const consignee = await ensureConsigneeInZone("P1");

    const res = await bookRaw(admin, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      requestor_id: driverId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REQUESTOR_NOT_FOUND");
  });

  it("rejects a requestor_id that doesn't exist at all", async () => {
    const admin = await loginAs(ADMIN);
    const rt = await firstRouteTypeId(admin);
    const consignee = await ensureConsigneeInZone("P1");

    const res = await bookRaw(admin, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      requestor_id: "nonexistent-id",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REQUESTOR_NOT_FOUND");
  });

  it("a REQUESTOR caller sending requestor_id cannot spoof another account — always booked as themselves", async () => {
    const requestor = await loginAs(REQUESTOR);
    const requestorId = await userIdByPhone(REQUESTOR.phone);
    const adminId = await userIdByPhone(ADMIN.phone);
    const rt = await firstRouteTypeId(requestor);
    const consignee = await ensureConsigneeInZone("P1");

    const res = await bookRaw(requestor, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: consignee.id }],
      cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      requestor_id: adminId, // attempted spoof
    });
    expect(res.status).toBe(201);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(trip.requestor_id).toBe(requestorId); // ignored — always self
  });
});
