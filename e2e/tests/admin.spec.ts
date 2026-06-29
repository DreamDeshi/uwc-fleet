import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR } from "../helpers/accounts";
import { getTrip, login, setDispatchMode } from "../helpers/api";
import { seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { adminLogin, gotoAdminTrips } from "../helpers/ui";

/**
 * ADMIN dashboard flows.
 *  4. Login → dashboard.
 *  5. A pending trip booked by a requestor appears on the board.
 *  6. Manual assign a driver → status becomes Assigned.
 *  7. With auto mode on, a new booking is auto-dispatched → Assigned.
 *  8. Toggle dispatch mode between manual and auto.
 */
test.describe("Admin (dashboard)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("4. logs in and sees the dashboard", async ({ page }) => {
    await adminLogin(page, ADMIN);
    // Dashboard landing page header subtitle.
    await expect(page.getByText("Live fleet overview")).toBeVisible();
  });

  test("5. shows a pending trip after a requestor books one", async ({ page }) => {
    const requestor = await login(REQUESTOR);
    const trip = await seedPendingTrip(requestor.accessToken);

    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    await expect(page.getByText("Pending Dispatch")).toBeVisible();
    await expect(page.getByText(trip.ticket_number)).toBeVisible();
    await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
  });

  test("6. manually assigns a driver to a pending trip → Assigned", async ({ page }) => {
    const requestor = await login(REQUESTOR);
    const trip = await seedPendingTrip(requestor.accessToken);

    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    // Open the trip → the dispatch panel with one Assign button per fitting driver.
    await page.getByText(trip.ticket_number).first().click();
    // Exact name: a substring match would also hit the "🚛 Assign Internal Driver" tab.
    const assign = page.getByRole("button", { name: "Assign", exact: true }).first();
    await expect(assign).toBeVisible();
    await assign.click();

    // Confirm the manual-assign action changed the trip's status end-to-end. (The
    // board is asserted via the API rather than the noisy shared dispatch list.)
    await expect
      .poll(async () => (await getTrip(adminToken, trip.id)).status)
      .toBe("assigned");
  });

  test("7. auto-dispatches a new booking when auto mode is on → Assigned", async ({ page }) => {
    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    try {
      // Turn on fully-automatic dispatch from the UI.
      await page.getByRole("button", { name: "Fully Automatic" }).click();
      await expect(page.getByText("Engine active — new orders auto-assign")).toBeVisible();

      // A booking created now is auto-dispatched on creation. Prefer an A2 (Ipoh)
      // consignee so the engine is forced onto Azmi/PLX 2406 — the only A-zone truck,
      // which reset() has just freed — making the assignment deterministic.
      const requestor = await login(REQUESTOR);
      const trip = await seedPendingTrip(requestor.accessToken, ["A2", "P2"]);
      expect(trip.status, "the engine should assign the trip on creation in auto mode").toBe(
        "assigned"
      );

      // Reflect it on the board.
      await page.reload();
      await expect(page.getByRole("button", { name: "Manual Dispatch" })).toBeVisible();
      await page.getByText(trip.ticket_number).first().click();
      // An assigned trip shows the monitor panel ("Delivery Progress"), not the
      // dispatch panel — confirming the engine assigned it.
      await expect(page.getByText("Delivery Progress")).toBeVisible();
    } finally {
      // Restore manual so later specs' seeded trips stay pending.
      await setDispatchMode(adminToken, "manual");
    }
  });

  test("8. toggles dispatch mode between manual and auto", async ({ page }) => {
    await adminLogin(page, ADMIN);
    await gotoAdminTrips(page);

    const engineActive = page.getByText("Engine active — new orders auto-assign");

    try {
      // Starts manual (reset). Switching to auto reveals the engine-active banner.
      await expect(engineActive).toHaveCount(0);
      await page.getByRole("button", { name: "Fully Automatic" }).click();
      await expect(engineActive).toBeVisible();

      // Switching back to manual hides it again.
      await page.getByRole("button", { name: "Manual Dispatch" }).click();
      await expect(engineActive).toHaveCount(0);
    } finally {
      await setDispatchMode(adminToken, "manual");
    }
  });
});
