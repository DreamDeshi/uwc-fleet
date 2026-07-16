import { test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { DRIVER, REQUESTOR, MOBILE_URL } from "../helpers/accounts";
import { login } from "../helpers/api";
import { mobileLogin } from "../helpers/ui";
import { resetState } from "../helpers/reset";
import {
  seedAssignedTrip,
  seedPendingTrip,
  pickRouteType,
  pickSearchableConsignee,
} from "../helpers/seed";

/**
 * Visual sweep — visits the driver and requestor screens of the mobile web app
 * and saves a full-page screenshot. No assertions: the goal is a folder of images
 * to eyeball for truncation / missing data / broken layout. Waits are best-effort
 * (wrapped so a missing element never aborts the capture) precisely so a BROKEN
 * screen is still photographed rather than failing the run.
 *
 * (Admin screens now live inside this same app, role-routed; a capture block for
 * them could be added via mobileLogin(page, ADMIN) if visual coverage is wanted.)
 *
 * Run just this file:  npx playwright test screenshots.spec.ts
 */

const SHOTS = path.resolve(__dirname, "../screenshots");
const PHONE = { width: 390, height: 844 }; // iPhone 12/13-ish, for the RN-web apps

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // Clean baseline, then give the boards something to show: one trip ASSIGNED to
  // the test driver (driver home + admin "active" group) and one left PENDING (admin "pending"
  // group + requestor history).
  const { adminToken } = await resetState();
  await seedAssignedTrip(adminToken);
  const requestor = await login(REQUESTOR);
  await seedPendingTrip(requestor.accessToken);
});

// Full-page screenshot with a best-effort wait for some text that signals the
// screen has rendered. Never throws — a screen that fails to show `waitText` is
// still captured (that's exactly the kind of bug we're hunting).
async function shot(
  page: import("@playwright/test").Page,
  name: string,
  waitText?: string | RegExp
): Promise<void> {
  if (waitText) {
    try {
      await page.getByText(waitText).first().waitFor({ timeout: 8000 });
    } catch {
      /* capture whatever rendered anyway */
    }
  }
  await page.waitForTimeout(1200); // let RN-web finish its enter animation
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

// Bottom-tab labels appear both in the tab bar and (sometimes) as a screen
// heading; the tab bar renders last in the DOM, so .last() targets the tab.
async function tapTab(page: import("@playwright/test").Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).last().click();
}

test("DRIVER — all screens", async ({ page }) => {
  await page.setViewportSize(PHONE);

  // Login page (pre-auth).
  await page.goto(MOBILE_URL);
  await shot(page, "driver-login", "Sign In");

  // Home / dashboard (shows the seeded assignment).
  await mobileLogin(page, DRIVER);
  await shot(page, "driver-home", "Assignments");

  // Trips tab.
  await tapTab(page, "Trips");
  await shot(page, "driver-trips");

  // Earnings screen.
  await tapTab(page, "Earnings");
  await shot(page, "driver-earnings", "My Earnings");

  // Profile screen.
  await tapTab(page, "Profile");
  await shot(page, "driver-profile");
});

test("REQUESTOR — all screens", async ({ page }) => {
  await page.setViewportSize(PHONE);

  // Resolve a route type + searchable consignee up front so the booking wizard
  // can be driven with known-good values.
  const { accessToken } = await login(REQUESTOR);
  const [routeType, consignee] = await Promise.all([
    pickRouteType(accessToken),
    pickSearchableConsignee(accessToken),
  ]);

  // Login page (pre-auth).
  await page.goto(MOBILE_URL);
  await shot(page, "requestor-login", "Sign In");

  // Home.
  await mobileLogin(page, REQUESTOR);
  await shot(page, "requestor-home", "Where do you need delivery?");

  // New Booking — step 1 (Where): empty form first…
  await tapTab(page, "New Booking");
  await shot(page, "requestor-booking-step1", "New Trip Request");

  // …then make valid selections so Next advances to step 2 (What).
  await page.getByText(routeType.name, { exact: true }).click();
  await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
  try {
    await page.getByText(consignee.display, { exact: true }).first().click({ timeout: 8000 });
  } catch {
    /* search may not surface it at this viewport; still advance/capture */
  }
  await page.getByText("Next", { exact: true }).click();
  await shot(page, "requestor-booking-step2", "Pallet Size & Quantity");

  // Step 2 → add one pallet → step 3 (Confirm).
  await page.getByText("+", { exact: true }).first().click();
  await page.getByText("Next", { exact: true }).click();
  await shot(page, "requestor-booking-step3", "Submit Booking");

  // Booking history.
  await tapTab(page, "Bookings");
  await shot(page, "requestor-bookings");
});
