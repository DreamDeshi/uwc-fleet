import { test, expect } from "@playwright/test";
import { REQUESTOR } from "../helpers/accounts";
import { login } from "../helpers/api";
import { pickRouteType, pickSearchableConsignee } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { mobileLogin } from "../helpers/ui";

/**
 * REQUESTOR flows on the mobile web app.
 *  1. Login with correct credentials → lands on home.
 *  2. Login with wrong password → shows error.
 *  3. Book a single-stop delivery → appears in history as Pending.
 */
test.describe("Requestor (mobile web)", () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test("1. logs in with correct credentials and lands on the home screen", async ({ page }) => {
    await mobileLogin(page, REQUESTOR);

    // Home screen: the requestor dashboard CTA. Its presence also proves we left
    // the login screen (the Sign In button is gone).
    await expect(page.getByText("Where do you need delivery?")).toBeVisible();
    await expect(page.getByText("Sign In", { exact: true })).toHaveCount(0);
  });

  test("2. shows an error when the password is wrong", async ({ page }) => {
    await mobileLogin(page, { phone: REQUESTOR.phone, password: "WrongPassword999" });

    // The server's 401 message is surfaced verbatim under the password field.
    await expect(page.getByText("Phone number or password is incorrect.")).toBeVisible();
    // Still on the login screen.
    await expect(page.getByText("Where do you need delivery?")).toHaveCount(0);
  });

  test("3. books a single-stop delivery that appears in history as Pending", async ({ page }) => {
    // Resolve a route type + a searchable consignee up front via the API, so the
    // UI steps are driven by known-good values.
    const { accessToken } = await login(REQUESTOR);
    const [routeType, consignee] = await Promise.all([
      pickRouteType(accessToken),
      pickSearchableConsignee(accessToken),
    ]);

    await mobileLogin(page, REQUESTOR);
    await expect(page.getByText("Where do you need delivery?")).toBeVisible();

    // Open the booking form.
    await page.getByText("Where do you need delivery?").click();
    await expect(page.getByText("New Trip Request")).toBeVisible();

    // ── Step 1: Where ── choose a route type, then search + add a consignee.
    await page.getByText(routeType.name, { exact: true }).click();

    await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
    const result = page.getByText(consignee.display, { exact: true });
    await expect(result).toBeVisible();
    await result.click();

    await page.getByText("Next", { exact: true }).click();

    // ── Step 2: What ── add one 4×4 pallet via the first stepper's "+".
    await expect(page.getByText("Pallet Size & Quantity")).toBeVisible();
    await page.getByText("+", { exact: true }).first().click();
    await expect(page.getByText("Total: 1 pallets")).toBeVisible();
    await page.getByText("Next", { exact: true }).click();

    // ── Step 3: Confirm ── submit.
    await page.getByText("Submit Booking", { exact: true }).click();

    // Success modal with the new ticket number.
    await expect(page.getByText("Booking Submitted!")).toBeVisible();
    const ticket = await page.getByText(/TKT-\d{8}-\d{3}/).first().textContent();
    expect(ticket, "a ticket number should be shown on the success modal").toBeTruthy();
    const ticketNo = ticket!.trim();

    await page.getByText("Back to Dashboard", { exact: true }).click();

    // ── History ── open the Bookings tab and confirm the new booking is Pending.
    await page.getByText("Bookings", { exact: true }).first().click();
    await expect(page.getByText(ticketNo).first()).toBeVisible();
    // StatusBadge renders the status uppercased.
    await expect(page.getByText("PENDING").first()).toBeVisible();
  });
});
