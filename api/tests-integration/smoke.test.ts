import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, REQUESTOR } from "./helpers/harness";

/**
 * Phase 0 smoke test: proves the integration harness works AND is isolated to
 * the Docker test DB. It logs in as the seeded requestor, books a real trip
 * through the HTTP API, reads it back, and confirms the row exists directly in
 * the (local, throwaway) database. If this passes, the isolation plumbing is
 * sound and later phases can build real money/dispatch/concurrency tests on it.
 */

// Tomorrow 09:00 Malaysia time (UTC+8) → a valid, in-window, future pickup.
function pickupIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9 - 8, 0)
  ).toISOString();
}

describe("smoke: isolated Docker test DB", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("logs in as the requestor, books a trip, and reads it back as pending", async () => {
    const token = await loginAs(REQUESTOR);

    // Reference data the booking needs.
    const routeTypes = await api().get("/api/v1/route-types").set(auth(token));
    expect(routeTypes.status).toBe(200);
    expect(routeTypes.body.length).toBeGreaterThan(0);

    const consignees = await api().get("/api/v1/consignees").set(auth(token));
    expect(consignees.status).toBe(200);
    expect(consignees.body.length).toBeGreaterThan(0);

    // Book the smallest valid trip (1×4×4 pallet, single stop).
    const create = await api()
      .post("/api/v1/trips")
      .set(auth(token))
      .send({
        route_type_id: routeTypes.body[0].id,
        pickup_datetime: pickupIso(),
        stops: [{ consignee_id: consignees.body[0].id }],
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
    expect(create.status).toBe(201);
    const tripId: string = create.body.id;
    expect(tripId).toBeTruthy();
    expect(create.body.status).toBe("pending");

    // Read it back over HTTP.
    const read = await api().get(`/api/v1/trips/${tripId}`).set(auth(token));
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(tripId);
    expect(read.body.status).toBe("pending");

    // Isolation proof: the trip is a real row in the Docker test DB.
    const inDb = await prisma.trip.findUnique({ where: { id: tripId } });
    expect(inDb).not.toBeNull();
    expect(inDb?.status).toBe("pending");
  });

  it("resetDb clears trips between tests (no leakage from the previous test)", async () => {
    const count = await prisma.trip.count();
    expect(count).toBe(0);
  });
});
