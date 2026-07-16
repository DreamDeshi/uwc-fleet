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
