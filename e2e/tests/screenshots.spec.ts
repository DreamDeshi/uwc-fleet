import { test, expect } from "@playwright/test";
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
  await shot(page, "driver-home", "Log");

  // Trips tab.
  await tapTab(page, "Trips");
  await shot(page, "driver-trips");

  // Earnings screen.
  await tapTab(page, "My Stats");
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

  // Home. Anchored on the tab bar, not a hero card: the redesigned phone Home
  // has two shapes (a "Next Booking" hero, or the first-run empty state) and
  // neither string is present in both.
  await mobileLogin(page, REQUESTOR);
  await shot(page, "requestor-home", "Insights");

  // New Booking — step 1 (Where): empty form first…
  // There is no "New Booking" tab at phone width — the requestor tab bar is
  // Home / Bookings / Insights / Profile, and booking is entered from the
  // Bookings tab's floating "+" (or Home's CTA, whose wording varies).
  await page.getByText("Bookings", { exact: true }).first().click();
  await page.getByLabel("New Booking").click();
  await shot(page, "requestor-booking-step1", "New Trip Request");

  // …then make valid selections so Next advances to step 2 (What). Route type
  // is now a family chip + a direction toggle resolving to one route_type_id.
  const norm = routeType.name.toLowerCase().replace(/[\s_-]+/g, "");
  const family = norm.startsWith("customer")
    ? "Customer"
    : norm.startsWith("supplier")
      ? "Supplier"
      : "Inter-Plant";
  await page.getByText(family, { exact: true }).click();
  await page.getByText(norm.includes("return") ? "Return" : "Delivery", { exact: true }).click();
  await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
  // WAIT for the row, then click it — no try/catch. This used to swallow a
  // failed selection and "still advance", which cannot work: Next has always
  // required a stop, so a swallowed miss left the walk on step 1 and captured
  // it under the step-2 name.
  //
  // VISIBLE-first, not `.first()`: the tab scenes stay mounted underneath and
  // render this consignee's name too once the account has bookings. See the
  // note in requestor.spec.ts.
  const result = page.getByText(consignee.display, { exact: true }).locator("visible=true").first();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await result.click();
  await page.getByText("Next", { exact: true }).click();
  await shot(page, "requestor-booking-step2", "Cargo Size & Quantity");

  // Step 2 → add one pallet → step 3 (When) → step 4 (Confirm).
  // selector-ok: the quantity stepper glyph is not a translated string
  await page.getByText("+", { exact: true }).first().click();
  await page.getByText("Next", { exact: true }).click();
  await shot(page, "requestor-booking-step3", "Pickup Date");
  await page.getByText("Next", { exact: true }).click();
  await shot(page, "requestor-booking-step4", "Submit Booking");

  // Booking history. Step 3 is a full-screen wizard whose Back / Submit footer
  // sits over the tab bar, so "Bookings" is present but permanently obscured —
  // leave the wizard by returning to the app root before tapping the tab.
  await page.goto(MOBILE_URL);
  await tapTab(page, "Bookings");
  await shot(page, "requestor-bookings");
});
