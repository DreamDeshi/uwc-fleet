import { test, expect } from "@playwright/test";
import { DRIVER } from "../helpers/accounts";
import { getTrip, login } from "../helpers/api";
import { seedAssignedTrip, seedArrivedTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { mobileLogin } from "../helpers/ui";
import { POD_FILE } from "../helpers/pod";

/**
 * DRIVER flows on the mobile web app.
 *  9.  Login → home screen shows the assigned trip.
 *  10. Start trip → status becomes in_progress.
 *  11. Upload DO photo + mark delivered → trip completed, incentive shown.
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

    await expect(page.getByText("Today's Assignment")).toBeVisible();
    // The assignment card shows the assigned status (uppercased by StatusBadge)
    // and the PLX 2406 driver's truck.
    await expect(page.getByText("ASSIGNED").first()).toBeVisible();
    await expect(page.getByText("PLX 2406").first()).toBeVisible();
  });

  test("10. starts the trip → status changes to in progress", async ({ page }) => {
    const trip = await seedAssignedTrip(adminToken);

    await mobileLogin(page, DRIVER);
    await expect(page.getByText("Today's Assignment")).toBeVisible();

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

  test("11. uploads a POD photo and marks delivered → completed with incentive", async ({
    page,
  }) => {
    const { trip } = await seedArrivedTrip(adminToken);

    await mobileLogin(page, DRIVER);
    // An in-progress trip surfaces the Active Trip card → View Navigation.
    await page.getByText("View Navigation", { exact: true }).click();

    // The stop is "arrived", so the POD gate is shown. Capturing the photo opens a
    // file chooser on web (expo-image-picker renders a hidden <input type=file>).
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Take POD Photo", { exact: true }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(POD_FILE);

    // Upload complete → the gate unlocks the Delivered action. (Both a toast and an
    // inline label read "POD photo uploaded", so scope to the first.)
    await expect(page.getByText("POD photo uploaded").first()).toBeVisible();

    // The Delivered button only enables once the POD upload's refetch lands, and
    // the bottom sheet can swallow the first tap as a drag — so retry the click
    // until the completion modal appears (short-circuiting once it's up).
    const completed = page.getByText("Trip Completed!");
    await expect(async () => {
      if (await completed.isVisible()) return;
      await page.getByText("Delivered", { exact: true }).click();
      await expect(completed).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 30_000 });

    // Completion modal with the earned incentive.
    await expect(completed).toBeVisible();
    await expect(page.getByText("Incentive Earned")).toBeVisible();
    await expect(page.getByText(/RM\s?\d/).first()).toBeVisible();

    // And the backend marked it completed.
    const driver = await login(DRIVER);
    await expect.poll(async () => (await getTrip(driver.accessToken, trip.id)).status).toBe(
      "completed"
    );
  });
});
