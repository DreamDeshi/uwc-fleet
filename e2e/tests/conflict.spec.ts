import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR, DRIVER } from "../helpers/accounts";
import { approveTrip, driverIdentity, getTrip, login } from "../helpers/api";
import { seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { adminLogin, gotoAdminTrips } from "../helpers/ui";

/**
 * SCHEDULING-CONFLICT — the admin UI override flow.
 *
 * The server-side conflict guard (409 SCHEDULING_CONFLICT, the force override,
 * the audit row, and the auto-dispatch skip) is now covered end-to-end at the
 * integration tier (api/tests-integration/guardLadder.test.ts +
 * concurrency.test.ts) — faster and more thorough than driving it through a
 * browser. What remains here is the one thing only the browser can prove: the
 * admin dispatch panel surfaces the inline "⚠ Scheduling conflict" warning and
 * the "Assign anyway" button re-submits with force.
 */
test.describe("Scheduling-conflict — admin UI override", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("UI: assigning a scheduled driver shows the ⚠ conflict warning, then 'Assign anyway' succeeds", async ({
    page,
  }) => {
    const requestor = await login(REQUESTOR);
    const testDriver = await driverIdentity(DRIVER);
    const testDriverName = (await login(DRIVER)).user.name;

    // Trip A → assign the PLX 2406 driver (pickup ~now+1h). the test driver now holds a SCHEDULED
    // (assigned, not in_progress) trip — so he stays selectable in the picker.
    const tripA = await seedPendingTrip(requestor.accessToken, ["P2"]);
    await approveTrip(adminToken, tripA.id, { driver_id: testDriver.id, truck_plate: testDriver.plate });

    // Trip B in the same pickup window → assigning the test driver clashes within the buffer.
    const tripB = await seedPendingTrip(requestor.accessToken, ["P2"]);

    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    // Open trip B's dispatch panel.
    await page.getByText(tripB.ticket_number).first().click();

    // the PLX 2406 driver's card is the picker card (in the dispatch panel) that carries an
    // Assign button — the deepest div that contains both his name and the button
    // (his left-board card for trip A has no Assign button, so it's excluded).
    const testDriverAssign = page
      .locator("div")
      .filter({ hasText: testDriverName })
      .filter({ has: page.getByRole("button", { name: "Assign", exact: true }) })
      .last()
      .getByRole("button", { name: "Assign", exact: true });
    await expect(testDriverAssign).toBeVisible();
    await testDriverAssign.click();

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
