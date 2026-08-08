import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR } from "../helpers/accounts";
import { login, getTrip, autoDispatch } from "../helpers/api";
import { seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { mobileLogin } from "../helpers/ui";

/**
 * REQUESTOR booking EDIT (pending only) on the mobile web app.
 *  1. Edit a pending booking's cargo + remarks through the wizard → the detail
 *     screen shows the change and the API confirms it persisted.
 *  2. Once a driver is assigned, the Edit button is gone.
 *
 * Pinned to a PHONE viewport for the same reason as requestor.spec.ts (the
 * ≥1024px desktop shell reflows the form but the flow/copy are identical).
 *
 * Locator note: inactive tab scenes (Home) stay in the DOM under the active
 * one and also render the ticket — as a bare number on the Next Booking hero,
 * and inside "<ticket> delivered" in Recent Activity — so a plain ticket
 * locator can resolve UNDER the active Bookings scene and never receive the
 * click. Only the Bookings-list phone card renders the ticket FOLLOWED BY " · ",
 * so that is what this anchors on.
 *
 * (It used to anchor on "<ticket> · <route type>". The requestor redesign put
 * the cargo shape there instead — "<ticket> · 1 stop · 1 pallet" — which is why
 * matching the whole composite is the wrong shape for this locator: it pins
 * copy the test does not care about.)
 */
function bookingCard(page: import("@playwright/test").Page, ticket: string) {
  return page.getByText(new RegExp(`^${ticket} · `)).first();
}

async function openBooking(
  page: import("@playwright/test").Page,
  trip: { ticket_number: string; [k: string]: unknown }
): Promise<void> {
  await page.getByText("Bookings", { exact: true }).first().click();
  await bookingCard(page, trip.ticket_number).click();
}
test.describe("Requestor booking edit (mobile web)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async () => {
    await resetState();
  });

  test("1. edits a pending booking's cargo and remarks", async ({ page }) => {
    const { accessToken } = await login(REQUESTOR);
    const trip = await seedPendingTrip(accessToken);
    const consigneeName = trip.stops[0]?.consignee?.company_name ?? "";
    expect(consigneeName, "seeded trip should include its consignee").toBeTruthy();

    await mobileLogin(page, REQUESTOR);
    await openBooking(page, trip);

    // Pending detail → Edit available.
    const editBtn = page.getByText("Edit Booking", { exact: true }).first();
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // The wizard opens in edit mode, pre-seeded, on the Confirm step.
    // "Schedule" is the Confirm step's own card title — the consignee name
    // itself also exists as a hidden copy on the detail screen underneath, so a
    // bare getByText(name).first() can resolve to that hidden node.
    await expect(page.getByText("Review before submitting.")).toBeVisible();
    await expect(page.getByText("Schedule", { exact: true })).toBeVisible();

    // Cargo section's "Edit" link. Confirm's cards are Schedule, Route, Cargo —
    // in that order — and the Documents card carries no Edit link.
    await page.getByText("Edit", { exact: true }).nth(2).click();
    // Label renamed by the Q1/Q10 structured-cargo change.
    await expect(page.getByText("Cargo Size & Quantity")).toBeVisible();
    // selector-ok: the quantity stepper glyph is not a translated string
    await page.getByText("+", { exact: true }).first().click();
    await expect(page.getByText("Total: 2 pallets")).toBeVisible();
    await page.getByText("Next", { exact: true }).click();

    // Remarks moved onto the "When" step with the pickup calendar and dial.
    await expect(page.getByText("Pickup Date", { exact: true })).toBeVisible();
    await page
      .getByPlaceholder("Special instructions for this delivery…")
      .fill("Handle with care");
    await page.getByText("Next", { exact: true }).click();
    await page.getByText("Save Changes", { exact: true }).click();

    // Back on the detail screen with the edited cargo (invalidation refetch).
    // "Pallet 4×4 × 2" is unique to the detail's cargo cell — list rows and
    // the (popped) wizard don't render it.
    await expect(page.getByText("Pallet 4×4 × 2").first()).toBeVisible();

    // The API agrees: still pending, cargo + remark replaced.
    const after = await getTrip(accessToken, trip.id);
    expect(after.status).toBe("pending");
    const cargo = (after as { cargo_details?: { quantity: number; remark: string | null }[] })
      .cargo_details;
    expect(cargo?.[0]?.quantity).toBe(2);
    expect(cargo?.[0]?.remark).toBe("Handle with care");
  });

  test("2. an assigned booking no longer offers Edit", async ({ page }) => {
    const [{ accessToken }, admin] = await Promise.all([login(REQUESTOR), login(ADMIN)]);
    const trip = await seedPendingTrip(accessToken);
    await autoDispatch(admin.accessToken, trip.id);

    await mobileLogin(page, REQUESTOR);
    await openBooking(page, trip);

    // Detail is open (the progress bar's own labels are visible) but Edit is
    // not offered. "Trip Details" was the card label before the requestor
    // redesign replaced that card with the fact rows and the stage bar.
    await expect(page.getByText("En Route", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Edit Booking", { exact: true })).toHaveCount(0);
  });
});
