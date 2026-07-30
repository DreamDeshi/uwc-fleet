import { test, expect } from "@playwright/test";
import { DRIVER } from "../helpers/accounts";
import { driverIdentity, getTrip, login, uploadPod } from "../helpers/api";
import { seedAssignedTripToday, seedArrivedTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { dismissGpsConsent, mobileLogin } from "../helpers/ui";
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
    await seedAssignedTripToday(adminToken);

    await mobileLogin(page, DRIVER);

    // Redesigned Home (Jul 2026): no "Assignments" heading and no StatusBadge —
    // an assigned-but-not-started trip renders as a card whose action is
    // "Start this trip". The plate is read from the account, not hardcoded:
    // the 29 Jul fleet revision moved this driver from PLX 2406 to PND 1888.
    await expect(page.getByText("Start this trip", { exact: true })).toBeVisible();
    const { plate } = await driverIdentity(DRIVER);
    await expect(page.getByText(plate).first()).toBeVisible();
  });

  test("10. starts the trip → status changes to in progress", async ({ page }) => {
    const trip = await seedAssignedTripToday(adminToken);

    await mobileLogin(page, DRIVER);
    // Redesigned Home: the start action sits on the Home card itself — the
    // intermediate "Trip Details" screen the old flow went through is gone.
    await page.getByText("Start this trip", { exact: true }).click();

    // Starting lands on the live ActiveTrip view, which raises the GPS-consent
    // overlay on first entry. The footer runs one primary at a time: a stop
    // that is still PENDING is at stage "arrived", so the control here is
    // "Arrived at Pickup" (step 1 of 3) — Delivered only appears two stages
    // later, once arrival and POD are done.
    await dismissGpsConsent(page);
    await expect(page.getByText("Arrived at Pickup", { exact: true })).toBeVisible();

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
    // An in-progress trip surfaces the Active Trip card → Continue trip.
    await page.getByText("Continue trip", { exact: true }).click();

    // The ActiveTrip screen raises the GPS-consent modal on first entry to an
    // in-progress trip. It is a full-screen overlay — until dismissed it
    // intercepts every tap on the controls beneath it (this was the "a <div>
    // intercepts pointer events" failure). A real driver answers it; dismiss
    // with "Not now" so tracking stays off and the POD/Delivered controls
    // become clickable.
    await dismissGpsConsent(page);

    // POD already uploaded (above), so the gate is satisfied and Delivered is
    // enabled. The inline label confirms it before we act.
    await expect(page.getByText(/POD (photo )?uploaded/).first()).toBeVisible();

    // The Delivered button enables once the POD refetch lands, and the bottom
    // sheet can swallow the first tap as a drag — so retry until the completion
    // modal appears, short-circuiting once it's up. force: the live map keeps
    // animating on a real (prod) network, so strict stability never settles and
    // an unforced click times out; the modal + API poll below still verify the
    // click actually delivered.
  // The completion modal is titled by trip.allStopsDelivered ("All N stops
  // delivered"). It used to be trip.completedTitle ("Trip Completed!"), which is
  // now a DEAD key — matching it made this a locator that can never resolve, so
  // the positive check below never short-circuited and the negative one in N4
  // passed vacuously.
    const completed = page.getByText(/All \d+ stops? delivered/).last();
    await expect(async () => {
      if (await completed.isVisible()) return;
      await page.getByText("Delivered", { exact: true }).click({ force: true });
      await expect(completed).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 30_000 });

    // Under the POD-approval gate (item 9, 16 Jul 2026) delivering the last stop
    // does NOT pay — it PROPOSES. The modal still says "Trip Completed!", but the
    // incentive is flagged awaiting admin approval, not earned, and the trip
    // lands in pending_approval (an admin approves the POD before it completes).
    await expect(completed).toBeVisible();
    // The amount is shown under a PENDING APPROVAL chip (trip.pendingApprovalChip)
    // with copy saying the office must approve it. The old assertions used
    // trip.incentivePending / trip.incentiveEarned, both dead keys — so the
    // "not paid" half was checking a string that can no longer render either way.
    await expect(page.getByText("PENDING APPROVAL")).toBeVisible();
    await expect(page.getByText(/will review your POD and approve/)).toBeVisible();
    await expect(page.getByText(/RM\s?\d/).first()).toBeVisible();

    // And the backend holds it at pending_approval — NOT completed, and NOT paid.
    const driverLogin = await login(DRIVER);
    await expect
      .poll(async () => (await getTrip(driverLogin.accessToken, trip.id)).status)
      .toBe("pending_approval");
  });
});
