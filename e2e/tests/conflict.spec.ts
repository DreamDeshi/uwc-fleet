import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR, DRIVER } from "../helpers/accounts";
import { approveTrip, driverIdentity, getTrip, login, setDispatchMode } from "../helpers/api";
import { seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { adminLogin, gotoAdminTrips } from "../helpers/ui";

/**
 * SCHEDULING-CONFLICT CHECK AT ASSIGNMENT (roadmap #2).
 *
 * These exercise the server-side conflict guard end-to-end: the 409
 * SCHEDULING_CONFLICT block, the force override ("Assign anyway"), and the
 * auto-dispatch skip. Some drive the backend through the API (the suite's
 * pattern for trip-state setup/assertions); the last one drives the FULL admin
 * UI flow.
 *
 * Phase 1 aligned the picker to the one-active model: a driver is hidden from
 * the dispatch picker ONLY while a trip is actually in_progress — an
 * assigned-but-not-started driver stays selectable. That makes the manual
 * "Assign anyway" override reachable by clicking through the UI (see the last
 * test), which previously could only be proven at the API level.
 */
test.describe("Scheduling-conflict check at assignment (roadmap #2)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("manual assign is blocked by a scheduling conflict, then succeeds with force", async () => {
    const requestor = await login(REQUESTOR);
    const azmi = await driverIdentity(DRIVER);

    // Trip 1 → assign Azmi/PLX 2406 (pickup ~now+1h): the driver+truck are now committed.
    const trip1 = await seedPendingTrip(requestor.accessToken, ["P2"]);
    await approveTrip(adminToken, trip1.id, { driver_id: azmi.id, truck_plate: azmi.plate });

    // Trip 2 in the same window → assigning Azmi clashes within the buffer.
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

    // Commit Azmi (the PRIMARY A-zone driver) to an A2 (Ipoh) trip in this window.
    const first = await seedPendingTrip(requestor.accessToken, ["A2"]);
    await approveTrip(adminToken, first.id, { driver_id: azmi.id, truck_plate: azmi.plate });

    await setDispatchMode(adminToken, "auto");
    try {
      // A new A2 booking is auto-dispatched on creation. The engine must NOT pick
      // Azmi (busy + conflicting) — it falls to an A1/A2 backup (Shahar/PND, or
      // Khoo/PRH for <2 pallets). If no backup fits it stays pending, but it must
      // never double-book Azmi.
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

  test("UI: assigning a scheduled driver shows the ⚠ conflict warning, then 'Assign anyway' succeeds", async ({
    page,
  }) => {
    const requestor = await login(REQUESTOR);
    const azmi = await driverIdentity(DRIVER);
    const azmiName = (await login(DRIVER)).user.name;

    // Trip A → assign Azmi/PLX 2406 (pickup ~now+1h). Azmi now holds a SCHEDULED
    // (assigned, not in_progress) trip — so he stays selectable in the picker.
    const tripA = await seedPendingTrip(requestor.accessToken, ["P2"]);
    await approveTrip(adminToken, tripA.id, { driver_id: azmi.id, truck_plate: azmi.plate });

    // Trip B in the same pickup window → assigning Azmi clashes within the buffer.
    const tripB = await seedPendingTrip(requestor.accessToken, ["P2"]);

    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    // Open trip B's dispatch panel.
    await page.getByText(tripB.ticket_number).first().click();

    // Azmi's card is the picker card (in the dispatch panel) that carries an
    // Assign button — the deepest div that contains both his name and the button
    // (his left-board card for trip A has no Assign button, so it's excluded).
    const azmiAssign = page
      .locator("div")
      .filter({ hasText: azmiName })
      .filter({ has: page.getByRole("button", { name: "Assign", exact: true }) })
      .last()
      .getByRole("button", { name: "Assign", exact: true });
    await expect(azmiAssign).toBeVisible();
    await azmiAssign.click();

    // The inline scheduling-conflict warning appears (no hard block).
    await expect(page.getByText("⚠ Scheduling conflict")).toBeVisible();

    // "Assign anyway" re-submits with force=true → the override proceeds.
    await page.getByRole("button", { name: "Assign anyway" }).click();

    // Trip B is assigned. Because the override + its assignment_conflict_override
    // audit row are written in the SAME Serializable transaction as the status
    // flip, a successful assignment guarantees the audit row was written.
    await expect.poll(async () => (await getTrip(adminToken, tripB.id)).status).toBe("assigned");
  });
});
