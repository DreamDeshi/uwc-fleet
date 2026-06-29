/**
 * Shared UI login helpers for the two front-ends.
 *
 * Both apps are built without testIDs, so selectors target rendered text and
 * input placeholders (see the per-spec comments). The mobile app is React Native
 * Web — its buttons render as clickable <div>s, so we click by visible text.
 */
import { expect, type Page } from "@playwright/test";
import { ADMIN_URL, MOBILE_URL, type Account } from "./accounts";

/**
 * Log into the mobile web app (requestor or driver). The phone field shows a
 * fixed "+60" prefix and the screen submits `+60` + the digits you type, so we
 * enter only the national part.
 */
export async function mobileLogin(page: Page, account: Account): Promise<void> {
  await page.goto(MOBILE_URL);
  const national = account.phone.replace(/^\+60/, "");
  await page.getByPlaceholder("12-345 6789").fill(national);
  await page.getByPlaceholder("Enter your password").fill(account.password);
  await page.getByText("Sign In", { exact: true }).click();
}

/** Log into the admin dashboard. The phone input takes the full +60… number. */
export async function adminLogin(page: Page, account: Account): Promise<void> {
  await page.goto(`${ADMIN_URL}/login`);
  await page.getByPlaceholder("+60100000001").fill(account.phone);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  // Land on the dashboard: the sidebar (present on every authed page) renders the
  // Trip Management nav link.
  await expect(page.getByRole("link", { name: "Trip Management" })).toBeVisible();
}

/** Open the admin Trip Management (dispatch) board. */
export async function gotoAdminTrips(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Trip Management" }).click();
  await expect(page).toHaveURL(/\/trips$/);
  // The dispatch-mode toggle sits at the top of the board and always renders,
  // even when there are no trips — a stable signal the page has loaded.
  await expect(page.getByRole("button", { name: "Manual Dispatch" })).toBeVisible();
}
