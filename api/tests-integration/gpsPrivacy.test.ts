import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, REQUESTOR, DRIVER } from "./helpers/harness";
import { firstRouteTypeId, bookTrip, approveTrip, startTrip, userIdByPhone, DRIVERS } from "./helpers/flow";

/**
 * GPS source round-trip: a driver's phone posts a fix (stamped source="phone"),
 * and the admin fleet map + requestor mini-map serve it back with that source
 * and a fresh (not stale) flag; a later vendor fix wins the preference.
 */

const PLX = DRIVERS.PLX;

describe("GPS tracking — source round-trip + preference", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("driver POST /locations → /fleet/live + /trips/:id/location return source=phone, fresh", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);

    const post = await api()
      .post("/api/v1/locations")
      .set(auth(driver))
      .send({ points: [{ trip_id: trip.id, latitude: 5.41, longitude: 100.33 }] });
    expect(post.status).toBe(201);

    // The row was stamped "phone".
    const row = await prisma.locationLog.findFirst({ where: { trip_id: trip.id } });
    expect(row!.source).toBe("phone");

    // Admin fleet map.
    const live = await api().get("/api/v1/fleet/live").set(auth(admin));
    expect(live.status).toBe(200);
    const pos = (live.body as { trip_id: string; source: string; stale: boolean; latitude: number }[]).find(
      (p) => p.trip_id === trip.id
    );
    expect(pos).toBeTruthy();
    expect(pos!.source).toBe("phone");
    expect(pos!.stale).toBe(false);
    expect(pos!.latitude).toBeCloseTo(5.41);

    // Requestor/owner mini-map.
    const loc = await api().get(`/api/v1/trips/${trip.id}/location`).set(auth(admin));
    expect(loc.status).toBe(200);
    expect(loc.body.source).toBe("phone");
    expect(loc.body.stale).toBe(false);

    // A fresher VENDOR fix wins the preference over the phone fix.
    await prisma.locationLog.create({
      data: { trip_id: trip.id, driver_id: plx, latitude: 3.14, longitude: 101.68, source: "vendor" },
    });
    const live2 = await api().get("/api/v1/fleet/live").set(auth(admin));
    const pos2 = (live2.body as { trip_id: string; source: string; latitude: number }[]).find(
      (p) => p.trip_id === trip.id
    );
    expect(pos2!.source).toBe("vendor");
    expect(pos2!.latitude).toBeCloseTo(3.14);
  });

  it("a trip with no fixes doesn't appear on /fleet/live (map → approximate) and /location is null", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id); // in_progress, but no GPS posted

    const live = await api().get("/api/v1/fleet/live").set(auth(admin));
    expect((live.body as { trip_id: string }[]).find((p) => p.trip_id === trip.id)).toBeUndefined();

    const loc = await api().get(`/api/v1/trips/${trip.id}/location`).set(auth(admin));
    expect(loc.body).toBeNull();
  });
});
