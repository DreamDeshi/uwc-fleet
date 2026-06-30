import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR, DRIVER } from "../helpers/accounts";
import { approveTrip, driverIdentity, getTrip, login, setDispatchMode } from "../helpers/api";
import { seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";

/**
 * SCHEDULING-CONFLICT CHECK AT ASSIGNMENT (roadmap #2).
 *
 * These drive the shared backend through the API (the suite's own pattern for
 * trip-state setup/assertions). They exercise the server-side conflict guard
 * end-to-end: the 409 SCHEDULING_CONFLICT block, the force override
 * ("Assign anyway"), and the auto-dispatch skip.
 *
 * Note: the admin picker currently hides a driver the moment they hold an
 * `assigned` trip (reports.ts derivedStatus), so a driver-dimension conflict is
 * not reachable by clicking through the picker today — hence the API-level
 * assertions here. The "Assign anyway" button is wired in DispatchPanel and
 * becomes reachable once the picker surfaces assigned-but-not-started drivers
 * (roadmap #2: "drivers stay available until a trip is actually started").
 */
test.describe("Scheduling-conflict check at assignment (roadmap #2)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("manual assign is blocked by a scheduling conflict, then succeeds with force", async () => {
    const requestor = await login(REQUESTOR);
    const azmi = await driverIdentity(DRIVER);

    // Trip 1 → assign Driver 1/PLX 2406 (pickup ~now+1h): the driver+truck are now committed.
    const trip1 = await seedPendingTrip(requestor.accessToken, ["P2"]);
    await approveTrip(adminToken, trip1.id, { driver_id: azmi.id, truck_plate: azmi.plate });

    // Trip 2 in the same window → assigning Driver 1 clashes within the buffer.
    const trip2 = await seedPendingTrip(requestor.accessToken, ["P2"]);

    // Without force → blocked with SCHEDULING_CONFLICT; trip stays pending.
    await expect(
      approveTrip(adminToken, trip2.id, { driver_id: azmi.id, truck_plate: azmi.plate })
    ).rejects.toThrow(/SCHEDULING_CONFLICT/);
    expect((await getTrip(adminToken, trip2.id)).status).toBe("pending");

    // With force ("Assign anyway") → the override proceeds; trip2 is assigned.
    await approveTrip(adminToken, trip2.id, {
      driver_id: azmi.id,
      truck_plate: azmi.plate,
      force: true,
    });
    expect((await getTrip(adminToken, trip2.id)).status).toBe("assigned");
  });

  test("auto-dispatch skips a busy/conflicted driver and assigns the next eligible one", async () => {
    const requestor = await login(REQUESTOR);
    const azmi = await driverIdentity(DRIVER);

    // Commit Driver 1 (the PRIMARY A-zone driver) to an A2 (Ipoh) trip in this window.
    const first = await seedPendingTrip(requestor.accessToken, ["A2"]);
    await approveTrip(adminToken, first.id, { driver_id: azmi.id, truck_plate: azmi.plate });

    await setDispatchMode(adminToken, "auto");
    try {
      // A new A2 booking is auto-dispatched on creation. The engine must NOT pick
      // Driver 1 (busy + conflicting) — it falls to an A1/A2 backup (Driver 2/PND, or
      // Driver 6/PRH for <2 pallets). If no backup fits it stays pending, but it must
      // never double-book Driver 1.
      const second = await seedPendingTrip(requestor.accessToken, ["A2"]);
      const after = await getTrip(adminToken, second.id);
      expect(after.driver_id, "must not auto-assign the busy/conflicted driver").not.toBe(azmi.id);
      if (after.status === "assigned") {
        expect(after.truck_plate).not.toBe(azmi.plate);
      } else {
        expect(after.status).toBe("pending");
      }
    } finally {
      await setDispatchMode(adminToken, "manual");
    }
  });
});
