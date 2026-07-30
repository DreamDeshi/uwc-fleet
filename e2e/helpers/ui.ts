/**
 * Shared UI login helper for the mobile web app (the one front-end).
 *
 * The app is built without testIDs, so selectors target rendered text and input
 * placeholders (see the per-spec comments). It's React Native Web — its buttons
 * render as clickable <div>s, so we click by visible text. (The legacy Vite
 * admin login helpers were removed when that app was retired.)
 */
import { type Page } from "@playwright/test";
import { MOBILE_URL, type Account } from "./accounts";

/**
 * Log into the mobile web app (requestor, driver, or admin — role-routed). The
 * phone field shows a fixed "+60" prefix and the screen submits `+60` + the
 * digits you type, so we enter only the national part.
 */
export async function mobileLogin(page: Page, account: Account): Promise<void> {
  await page.goto(MOBILE_URL);
  const national = account.phone.replace(/^\+60/, "");
  await page.getByPlaceholder("12-345 6789").fill(national);
  await page.getByPlaceholder("Enter your password").fill(account.password);
  await page.getByText("Sign In", { exact: true }).click();
}

/**
 * Dismiss the GPS-consent overlay that ActiveTrip raises on first entry to an
 * in-progress trip.
 *
 * It is a full-screen overlay: until it goes, every tap on the controls beneath
 * it is intercepted. Callers used to probe it with a bare `isVisible()`, which
 * does NOT wait — the check ran before the modal had mounted, found nothing,
 * skipped the click, and the very next action timed out against an overlay that
 * had appeared in the meantime. That race is why the driver specs failed in a
 * full run but passed in isolation. Wait for it, then dismiss; a trip that
 * never raises it (consent already recorded) just falls through.
 */
export async function dismissGpsConsent(page: Page): Promise<void> {
  const notNow = page.getByText("Not now", { exact: true });
  try {
    await notNow.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return; // never appeared — consent already answered for this session
  }
  await notNow.click();
  await notNow.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}
