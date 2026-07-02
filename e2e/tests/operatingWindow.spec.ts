import { test, expect } from "@playwright/test";
import { REQUESTOR, DRIVER } from "../helpers/accounts";
import { approveTrip, driverIdentity, getTrip, login, setDispatchMode } from "../helpers/api";
import { seedPendingTripAt } from "../helpers/seed";
import { resetState } from "../helpers/reset";

/**
 * 07:00–18:00 OPERATING-WINDOW CUTOFF (Phase 3 — AUTO DISPATCH LOGIC A36–A38).
 *
 * Drives the shared backend through the API. The pure estimate is unit-tested in
 * api/tests/operatingWindow.test.ts (17:30 ok / 18:40 exceeds / 06:30 flagged /
 * MYT); these verify the integration:
 *   - auto mode: a route finishing past 18:00 is NOT assigned → pending + flagged;
 *   - manual mode: it WARNS (409 OPERATING_WINDOW) and proceeds with force;
 *   - a normal mid-day route is unaffected.
 *
 * Pickups use an explicit MYT (UTC+8) wall-clock time a few days out, so the
 * outcome never depends on when the suite runs.
 */

// A pickup `daysAhead` days from now at `mytHour:mytMin` Malaysia time (UTC+8).
function futureMytPickup(daysAhead: number, mytHour: number, mytMin = 0): string {
  const now = new Date();
  // MYT hour → UTC hour by subtracting 8; Date.UTC normalises any underflow.
  const ms = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysAhead,
    mytHour - 8,
    mytMin
  );
  return new Date(ms).toISOString();
}

test.describe("Operating-window cutoff (Phase 3)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("auto mode does NOT assign a route that finishes past 18:00 → pending + flagged", async () => {
    const requestor = await login(REQUESTOR);
    await setDispatchMode(adminToken, "auto");
    try {
      // Pickup 17:30 MYT, 1 stop ⇒ est. completion ≈ 19:05, past the 18:00 window.
      const trip = await seedPendingTripAt(requestor.accessToken, futureMytPickup(5, 17, 30), ["P2"]);
      const after = await getTrip(adminToken, trip.id);
      expect(after.status, "must not auto-assign a past-window route").toBe("pending");
      expect(after.auto_dispatch_failed).toBe(true);
      // pickup_datetime is never mutated by the cutoff.
      expect(new Date(after.pickup_datetime).toISOString()).toBe(
        new Date(trip.pickup_datetime).toISOString()
      );
    } finally {
      await setDispatchMode(adminToken, "manual");
    }
  });

  test("manual assign WARNS (OPERATING_WINDOW), then succeeds with force", async () => {
    const requestor = await login(REQUESTOR);
    const testDriver = await driverIdentity(DRIVER);

    const trip = await seedPendingTripAt(requestor.accessToken, futureMytPickup(6, 17, 30), ["P2"]);

    // Without force → 409 OPERATING_WINDOW; the trip stays pending.
    await expect(
      approveTrip(adminToken, trip.id, { driver_id: testDriver.id, truck_plate: testDriver.plate })
    ).rejects.toThrow(/OPERATING_WINDOW/);
    expect((await getTrip(adminToken, trip.id)).status).toBe("pending");

    // With force ("Assign anyway") → the override proceeds.
    await approveTrip(adminToken, trip.id, {
      driver_id: testDriver.id,
      truck_plate: testDriver.plate,
      force: true,
    });
    expect((await getTrip(adminToken, trip.id)).status).toBe("assigned");
  });

  test("a normal mid-day route assigns without warning", async () => {
    const requestor = await login(REQUESTOR);
    const testDriver = await driverIdentity(DRIVER);

    // Pickup 10:00 MYT, 1 stop ⇒ est. completion ≈ 11:35, comfortably in-window.
    const trip = await seedPendingTripAt(requestor.accessToken, futureMytPickup(7, 10, 0), ["P2"]);
    await approveTrip(adminToken, trip.id, { driver_id: testDriver.id, truck_plate: testDriver.plate });
    expect((await getTrip(adminToken, trip.id)).status).toBe("assigned");
  });
});
