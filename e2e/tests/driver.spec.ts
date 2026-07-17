import { test, expect } from "@playwright/test";
import { DRIVER } from "../helpers/accounts";
import { driverIdentity, getTrip, login, uploadPod } from "../helpers/api";
import { seedAssignedTrip, seedArrivedTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { mobileLogin } from "../helpers/ui";
import { POD_FILE } from "../helpers/pod";

/**
 * DRIVER flows on the mobile web app.
 *  9.  Login → home screen shows the assigned trip.
 *  10. Start trip → status becomes in_progress.
 *  11. Mark a POD'd stop delivered → PENDING APPROVAL (item 9), incentive proposed.
 *
 * Each test seeds its own trip for the test driver via the API; reset() frees the test driver first so
 * the "one active trip per driver" rule never blocks the fresh assignment.
 */
test.describe("Driver (mobile web)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("9. logs in and sees the assigned trip on the home screen", async ({ page }) => {
    await seedAssignedTrip(adminToken);

    await mobileLogin(page, DRIVER);

    // The driver home's assignment section title is i18n key driver.todaysAssignments,
    // which renders as "Assignments" (the singular "Today's Assignment" key is dead).
    await expect(page.getByText("Assignments", { exact: true })).toBeVisible();
    // The assignment card shows the assigned status (uppercased by StatusBadge)
    // and the PLX 2406 driver's truck.
    await expect(page.getByText("ASSIGNED").first()).toBeVisible();
    await expect(page.getByText("PLX 2406").first()).toBeVisible();
  });

  test("10. starts the trip → status changes to in progress", async ({ page }) => {
    const trip = await seedAssignedTrip(adminToken);

    await mobileLogin(page, DRIVER);
    // The driver home's assignment section title is i18n key driver.todaysAssignments,
    // which renders as "Assignments" (the singular "Today's Assignment" key is dead).
    await expect(page.getByText("Assignments", { exact: true })).toBeVisible();

    // Assignment card → Trip Details → Start Trip.
    await page.getByText("View Trip Details", { exact: true }).click();
    await page.getByText("Start Trip", { exact: true }).click();

    // Starting replaces the screen with the live ActiveTrip view (Navigate button).
    await expect(page.getByText("Navigate", { exact: true })).toBeVisible();

    // Confirm the backend transition too.
    const driver = await login(DRIVER);
    await expect
      .poll(async () => (await getTrip(driver.accessToken, trip.id)).status)
      .toBe("in_progress");
  });

  test("11. marks a POD'd stop delivered → pending approval, incentive proposed not paid", async ({
    page,
  }) => {
    const { trip, stopId } = await seedArrivedTrip(adminToken);

    // Satisfy the POD documentation gate via the API — the SAME multipart
    // request the driver app sends (helpers/api.uploadPod), so the gate is met
    // legitimately, not stubbed. The in-app photo capture is expo-image-picker's
    // browser camera flow, which headless Chromium cannot drive (no filechooser
    // ever opens — verified: the click lands with force:true, but the capture
    // path short-circuits without a camera). This test's subject is the item-9
    // delivery→approval transition, not the capture widget, so we seed past it.
    const driver = await driverIdentity(DRIVER);
    await uploadPod(driver.token, trip.id, stopId, POD_FILE);

    await mobileLogin(page, DRIVER);
    // An in-progress trip surfaces the Active Trip card → View Navigation.
    await page.getByText("View Navigation", { exact: true }).click();

    // The ActiveTrip screen raises the GPS-consent modal on first entry to an
    // in-progress trip. It is a full-screen overlay — until dismissed it
    // intercepts every tap on the controls beneath it (this was the "a <div>
    // intercepts pointer events" failure). A real driver answers it; dismiss
    // with "Not now" so tracking stays off and the POD/Delivered controls
    // become clickable.
    const notNow = page.getByText("Not now", { exact: true });
    if (await notNow.isVisible().catch(() => false)) await notNow.click();

    // POD already uploaded (above), so the gate is satisfied and Delivered is
    // enabled. The inline label confirms it before we act.
    await expect(page.getByText("POD photo uploaded").first()).toBeVisible();

    // The Delivered button enables once the POD refetch lands, and the bottom
    // sheet can swallow the first tap as a drag — so retry until the completion
    // modal appears, short-circuiting once it's up.
    const completed = page.getByText("Trip Completed!");
    await expect(async () => {
      if (await completed.isVisible()) return;
      await page.getByText("Delivered", { exact: true }).click();
      await expect(completed).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 30_000 });

    // Under the POD-approval gate (item 9, 16 Jul 2026) delivering the last stop
    // does NOT pay — it PROPOSES. The modal still says "Trip Completed!", but the
    // incentive is flagged awaiting admin approval, not earned, and the trip
    // lands in pending_approval (an admin approves the POD before it completes).
    await expect(completed).toBeVisible();
    await expect(page.getByText("Incentive — Pending Approval")).toBeVisible();
    await expect(page.getByText("Incentive Earned")).not.toBeVisible();
    await expect(page.getByText(/RM\s?\d/).first()).toBeVisible();

    // And the backend holds it at pending_approval — NOT completed, and NOT paid.
    const driverLogin = await login(DRIVER);
    await expect
      .poll(async () => (await getTrip(driverLogin.accessToken, trip.id)).status)
      .toBe("pending_approval");
  });
});
