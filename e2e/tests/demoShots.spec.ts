/**
 * Poster captures from the live SDG demo instance.
 *
 * Three frames: the admin dispatch board, a driver's active trip, and a
 * driver's earnings. They replace the existing poster images, which were taken
 * from a database carrying real UWC driver names and therefore cannot be shown
 * publicly.
 *
 * READ-ONLY. Logs in and navigates; creates nothing, completes nothing. The
 * demo's clean five-trip state must survive so the viva shows the same board
 * the poster does.
 */
import { test, expect, type Page } from "@playwright/test";

const PASSWORD = process.env.DEMO_PASSWORD ?? "UwcDemo2026!";
const ADMIN = "100000001";   // +60100000001, national part
const DRIVER = "100000101";  // +60100000101 — Driver 1, has the in-progress and completed trips
const OUT = "screenshots/demo";

async function login(page: Page, national: string) {
  await page.goto("/");
  await page.getByPlaceholder("12-345 6789").fill(national);
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByText("Sign In", { exact: true }).click();
}

/** The GPS consent overlay intercepts every tap beneath it until dismissed. */
async function dismissGpsConsent(page: Page) {
  const notNow = page.getByText("Not now", { exact: true });
  try {
    await notNow.waitFor({ state: "visible", timeout: 6_000 });
  } catch {
    return;
  }
  await notNow.click();
  await notNow.waitFor({ state: "hidden", timeout: 6_000 }).catch(() => {});
}

/**
 * Guard every capture: if a real personal name reaches the frame, the whole
 * exercise has failed and the image must not be used. The demo seeds
 * "Driver 1"…"Driver 8" and "Requestor 1", so anything shaped like a real
 * Malaysian name means the private overlay leaked in.
 */
async function assertAnonymous(page: Page, where: string) {
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const leaks = ["Mohd ", "Mohamad ", "Muhamad ", "Muhammad ", "Amirudin", "Khoo ", "Tan Wei Ming"];
  for (const l of leaks) {
    expect(body, `${where}: "${l.trim()}" appeared — this frame carries a real name`).not.toContain(l);
  }
}

test("@desktop admin dispatch board", async ({ page }) => {
  await login(page, ADMIN);
  // ⚠ Admin lands on Dashboard, NOT the dispatch board — the first version of
  // this captured the landing page and called it the board. Navigate to Trip
  // Management explicitly.
  await page.getByText("Trip Management", { exact: true }).click();
  // Wait on the board's own heading, not a ticket number: tickets live inside a
  // scrolled column and the regex matched an off-screen node before the board
  // had painted.
  //
  // ⚠ "Pending Dispatch", not "PENDING DISPATCH". The caps on screen are a CSS
  // textTransform, not the string — the source is admin.trips.groupPending.
  // The uppercase literal still MATCHED at runtime, because exact:false is
  // case-insensitive, so this only surfaced when the selector-drift guard
  // compared it against live copy. A selector that works by accident is one
  // rename away from failing for a reason nobody can see.
  await expect(page.getByText("Pending Dispatch", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await assertAnonymous(page, "admin dispatch board");
  await page.screenshot({ path: `${OUT}/01-admin-dispatch-board.png`, fullPage: false });
});

test("@phone driver active trip", async ({ page }) => {
  await login(page, DRIVER);
  await dismissGpsConsent(page);
  // Driver 1 holds the in_progress trip; Home offers it as the continue path.
  const cont = page.getByText(/Continue|Active Trip|In Progress/i).first();
  await cont.waitFor({ state: "visible", timeout: 60_000 });
  await cont.click();
  await dismissGpsConsent(page);
  await page.waitForTimeout(2_000); // map + stop list
  await assertAnonymous(page, "driver active trip");
  await page.screenshot({ path: `${OUT}/02-driver-active-trip.png`, fullPage: false });
});

test("@phone driver earnings", async ({ page }) => {
  await login(page, DRIVER);
  await dismissGpsConsent(page);
  await page.getByText("My Stats", { exact: false }).first().click();
  await page.waitForTimeout(1_500);
  await assertAnonymous(page, "driver earnings");
  await page.screenshot({ path: `${OUT}/03-driver-earnings.png`, fullPage: false });
});
