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
 *
 * VIEWPORT: the shared config forces 1440×900 so the ADMIN app renders its full
 * dashboard. At ≥1024px the requestor app now mounts its DESKTOP SHELL (a left
 * sidebar drawer, `useWide` / RequestorDrawer) instead of the bottom tabs — so
 * "Bookings" becomes a sidebar item and the booking form reflows into columns.
 * The underlying booking FLOW is identical in both layouts (same 4-step wizard,
 * same strings — BookingFormScreen's `wide` flag only changes layout, not copy),
 * and the phone layout is the app's primary form factor. We therefore pin this
 * flow spec to a PHONE viewport so its text/placeholder selectors stay valid;
 * the desktop shell's wide layout is exercised visually by screenshots.spec.
 *
 * ⚠ HOME IS ASSERTED VIA THE TAB BAR, not a hero string. The requestor redesign
 * gives the phone Home two shapes — a "Next Booking" hero when something is
 * live, a first-run empty state when nothing ever was — so no single card is
 * always present. The bottom tab bar is: it mounts with the signed-in shell and
 * does not exist on the login screen, which is exactly the distinction these
 * two tests need.
 */

// The route-type control is a family chip + a direction toggle (the six seeded
// route types are {Customer|Supplier|Inter-Plant} × {Delivery|Return}). Mirrors
// mobile/src/lib/routeDirection.ts — deliberately re-derived here rather than
// imported, so a change to that mapping shows up as a RED test rather than
// both sides moving together and proving nothing.
function routeChips(routeTypeName: string): { family: string; direction: string } {
  const norm = routeTypeName.toLowerCase().replace(/[\s_-]+/g, "");
  const family = norm.startsWith("customer")
    ? "Customer"
    : norm.startsWith("supplier")
      ? "Supplier"
      : "Inter-Plant";
  return { family, direction: norm.includes("return") ? "Return" : "Delivery" };
}
test.describe("Requestor (mobile web)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async () => {
    await resetState();
  });

  test("1. logs in with correct credentials and lands on the home screen", async ({ page }) => {
    await mobileLogin(page, REQUESTOR);

    // Signed-in shell: the bottom tab bar. Its presence also proves we left the
    // login screen (the Sign In button is gone).
    await expect(page.getByText("Insights", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Sign In", { exact: true })).toHaveCount(0);
  });

  test("2. shows an error when the password is wrong", async ({ page }) => {
    await mobileLogin(page, { phone: REQUESTOR.phone, password: "WrongPassword999" });

    // The server's 401 message is surfaced verbatim under the password field.
    // selector-ok: server-supplied message from api/src/routes/auth.ts, never localised
    await expect(page.getByText("Phone number or password is incorrect.")).toBeVisible();
    // Still on the login screen — the signed-in shell never mounted.
    await expect(page.getByText("Insights", { exact: true })).toHaveCount(0);
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

    // Open the booking form from the Bookings tab's floating "+". Home's entry
    // point changes wording with the account's state ("Need another truck?" vs
    // the first-run "New Booking"); the FAB is the one that does not.
    await page.getByText("Bookings", { exact: true }).first().click();
    await page.getByLabel("New Booking").click();
    await expect(page.getByText("New Trip Request")).toBeVisible();

    // ── Step 1: Where ── pick the route family + direction, then search + add
    // a consignee. The two controls together resolve to one route_type_id; the
    // resolved name is echoed back below them.
    const chips = routeChips(routeType.name);
    await page.getByText(chips.family, { exact: true }).click();
    await page.getByText(chips.direction, { exact: true }).click();
    await expect(page.getByText(routeType.name, { exact: true })).toBeVisible();

    await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
    // ⚠ PICK THE VISIBLE MATCH — never `.first()` or `.last()`. This name is on
    // screen up to four times, in two different senses:
    //
    //  - VISIBLE, on this form: the search-results row and the "Recent" chip
    //    (names ≤ RECENT_CHIP_MAX_CHARS aren't truncated, so both are exact).
    //  - HIDDEN, underneath: React Navigation keeps the tab scenes mounted, and
    //    once this account has bookings, Home's Next-Booking hero and every
    //    Bookings card render the consignee name too.
    //
    // Both ordinal guesses have now been wrong. `.last()` was written for a
    // layout where recents rendered ABOVE the results; the redesign moved them
    // below. `.first()` then picked a HIDDEN ghost from a tab scene and waited
    // 20s for it to become visible, which it never does. Filtering to visible
    // first is the only form that does not depend on either.
    const result = page.getByText(consignee.display, { exact: true }).locator("visible=true").first();
    await expect(result).toBeVisible();
    await result.click();

    await page.getByText("Next", { exact: true }).click();

    // ── Step 2: What ── add one 4×4 pallet via the first stepper's "+".
    // (Label renamed "Pallet Size & Quantity" → "Cargo Size & Quantity" by the
    // Q1/Q10 structured-cargo change; the default tab is still the pallet grid.)
    await expect(page.getByText("Cargo Size & Quantity")).toBeVisible();
    // selector-ok: the quantity stepper glyph is not a translated string
    await page.getByText("+", { exact: true }).first().click();
    await expect(page.getByText("Total pallet spaces: 1")).toBeVisible();
    await page.getByText("Next", { exact: true }).click();

    // ── Step 3: When ── the pickup slot is pre-filled with the next bookable
    // one, so this step is a pass-through. Asserted, not skipped: if the
    // default ever stopped being valid, Next would block here.
    await expect(page.getByText("Pickup Date", { exact: true })).toBeVisible();
    await page.getByText("Next", { exact: true }).click();

    // ── Step 4: Confirm ── submit.
    await page.getByText("Submit Booking", { exact: true }).click();

    // Success modal with the new ticket number. Anchored: hidden inactive
    // scenes can hold "TKT-… · <date>" composites of OLDER tickets, and an
    // unanchored .first() can read one of those instead of the modal's.
    await expect(page.getByText("Booking submitted")).toBeVisible();
    const ticket = await page.getByText(/^TKT-\d{8}-\d{3}$/).last().textContent();
    expect(ticket, "a ticket number should be shown on the success modal").toBeTruthy();
    const ticketNo = ticket!.trim();

    await page.getByText("Back to Dashboard", { exact: true }).click();

    // ── History ── open the Bookings tab and confirm the new booking is Pending.
    await page.getByText("Bookings", { exact: true }).first().click();
    await expect(page.getByText(ticketNo).first()).toBeVisible();
    // StatusBadge renders the status uppercased.
    // selector-ok: status chip is uppercased at render; i18n holds "Pending"
    await expect(page.getByText("PENDING").first()).toBeVisible();
  });
});
