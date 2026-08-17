import { test, expect, type Page } from "@playwright/test";
import { ADMIN, DRIVER, REQUESTOR } from "../helpers/accounts";
import {
  approveTrip,
  createTrip,
  driverIdentity,
  driverStatus,
  getTrip,
  getTrips,
  login,
  reportException,
  searchConsignees,
  uploadK2,
  uploadPod,
  type Trip,
} from "../helpers/api";
import { pickRouteType, pickSearchableConsignee, seedAssignedTrip, seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";
import { dismissGpsConsent, mobileLogin } from "../helpers/ui";
import { POD_FILE } from "../helpers/pod";

/**
 * Live click-through of the July-2026 feature branch (PR #2 stack), the parts
 * no earlier spec exercises:
 *
 *  Requestor — structured cargo (Q10): Box count-only + Custom with dimensions.
 *  Requestor — booking templates: save on Confirm, re-apply on a new booking.
 *  Driver    — K2 destination gate (R1 Q6): Delivered stays locked until the
 *              Borang K2 document is UPLOADED (not ticked).
 *  Exceptions (Phase 1, BOTH flags on: FEATURE_EXCEPTIONS +
 *              EXPO_PUBLIC_FEATURE_EXCEPTIONS): driver report sheet validation,
 *              admin verify lane, requestor redacted banner.
 *  Admin     — undo grace window on cancel; bulk-reject of pending bookings.
 *
 * Camera-driven capture (POD / K2 / exception photo) cannot run in headless
 * Chromium (expo-image-picker's camera flow short-circuits without a device
 * camera — same limitation driver.spec.ts documents), so photo uploads are
 * seeded through the SAME multipart API requests the app sends, and the
 * browser assertions cover everything around them.
 */

// ── shared fixtures ──────────────────────────────────────────────────────

/**
 * A pending trip whose single stop actually requires the Borang K2 customs
 * document.
 *
 * NOT zone "K2" — that is Sungai Petani/Kedah and has nothing to do with the
 * form. The two just share a name, and this fixture used to conflate them, so
 * the gate below was never really exercised. The real rule (owner decision
 * 29 Jul, mirrored in api/src/services/incentiveEngine.ts and
 * mobile/src/lib/activeTripStage.ts) is CUSTOMS_DOC_ZONE "P1" AND an `area`
 * containing "BAYAN LEPAS" — Penang Island is gated by AREA, not by zone,
 * because only about half of P1 sits in the free-trade zone.
 */
async function seedPendingK2Trip(requestorToken: string): Promise<Trip> {
  const routeType = await pickRouteType(requestorToken);
  const p1 = await searchConsignees(requestorToken, { zone: "P1" });
  const k2 = p1.filter((c) => (c.area ?? "").toUpperCase().includes("BAYAN LEPAS"));
  expect(k2.length, "test DB should hold P1 consignees in BAYAN LEPAS").toBeGreaterThan(0);
  const pickup = new Date();
  pickup.setUTCDate(pickup.getUTCDate() + 1);
  pickup.setUTCHours(9 - 8, 0, 0, 0); // 09:00 MYT tomorrow — inside the operating window
  return createTrip(requestorToken, {
    route_type_id: routeType.id,
    pickup_datetime: pickup.toISOString(),
    stops: [{ consignee_id: k2[0].id }],
    cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
  });
}

/** Assign a trip to the test driver, forcing past zone/scheduling advisories. */
async function assignToTestDriver(adminToken: string, tripId: string): Promise<Trip> {
  const driver = await driverIdentity(DRIVER);
  return approveTrip(adminToken, tripId, {
    driver_id: driver.id,
    truck_plate: driver.plate,
    force: true,
  });
}

/** Enter the ActiveTrip screen from the driver home and clear the GPS-consent modal. */
async function openActiveTrip(page: Page): Promise<void> {
  await page.getByText("Continue trip", { exact: true }).click();
  await dismissGpsConsent(page);
}

// ── Requestor: structured cargo + templates (phone layout) ───────────────

test.describe("Structured cargo & templates (requestor, mobile web)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async () => {
    await resetState();
  });

  // The route-type control is a family chip + a direction toggle (the six
  // seeded route types are {Customer|Supplier|Inter-Plant} × {Delivery|Return}).
  // Mirrors mobile/src/lib/routeDirection.ts.
  function routeChips(routeTypeName: string): { family: string; direction: string } {
    const norm = routeTypeName.toLowerCase().replace(/[\s_-]+/g, "");
    const family = norm.startsWith("customer")
      ? "Customer"
      : norm.startsWith("supplier")
        ? "Supplier"
        : "Inter-Plant";
    return { family, direction: norm.includes("return") ? "Return" : "Delivery" };
  }

  /** Open the booking form from the Bookings tab's floating "+". Home's own
   *  entry point changes wording with the account's state; the FAB does not. */
  async function openBookingForm(page: Page): Promise<void> {
    await page.getByText("Bookings", { exact: true }).first().click();
    await page.getByLabel("New Booking").click();
    await expect(page.getByText("New Trip Request")).toBeVisible();
  }

  /** Drive the wizard through Step 1 (route + consignee) to the cargo step. */
  async function toCargoStep(page: Page): Promise<void> {
    const { accessToken } = await login(REQUESTOR);
    const [routeType, consignee] = await Promise.all([
      pickRouteType(accessToken),
      pickSearchableConsignee(accessToken),
    ]);

    await mobileLogin(page, REQUESTOR);
    await openBookingForm(page);
    const chips = routeChips(routeType.name);
    await page.getByText(chips.family, { exact: true }).click();
    await page.getByText(chips.direction, { exact: true }).click();
    await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
    // VISIBLE-first, not .first()/.last() — see the note in requestor.spec.ts.
    const result = page.getByText(consignee.display, { exact: true }).locator("visible=true").first();
    await expect(result).toBeVisible();
    await result.click();
    await page.getByText("Next", { exact: true }).click();
    await expect(page.getByText("Cargo Type")).toBeVisible();
  }

  /** Cargo step → Confirm. "When" sits between them, pre-filled and passive. */
  async function toConfirmStep(page: Page): Promise<void> {
    await page.getByText("Next", { exact: true }).click();
    await expect(page.getByText("Pickup Date", { exact: true })).toBeVisible();
    await page.getByText("Next", { exact: true }).click();
    await expect(page.getByText("Review before submitting.")).toBeVisible();
  }

  async function submitAndReadTicket(page: Page): Promise<string> {
    await page.getByText("Submit Booking", { exact: true }).click();
    await expect(page.getByText("Booking submitted")).toBeVisible();
    // The modal's ticket is a BARE text node; inactive scenes underneath keep
    // "TKT-… · <date>" composites of OLDER tickets in the DOM, so the regex is
    // anchored to the whole text and .last() prefers the just-mounted modal.
    const ticket = await page.getByText(/^TKT-\d{8}-\d{3}$/).last().textContent();
    expect(ticket).toBeTruthy();
    return ticket!.trim();
  }

  async function tripByTicket(ticket: string): Promise<Trip> {
    const { accessToken } = await login(REQUESTOR);
    const trips = await getTrips(accessToken);
    const trip = trips.find((t) => t.ticket_number === ticket);
    expect(trip, `trip ${ticket} should exist via the API`).toBeTruthy();
    return trip!;
  }

  test("N1. books BOX cargo — count only, no dimensions, flagged for manual assignment", async ({
    page,
  }) => {
    await toCargoStep(page);

    // Box tab: a single count stepper, no dimension inputs, and the
    // manual-assignment hint (Q10: boxes always go to the dispatcher).
    await page.getByText("Box", { exact: true }).click();
    await expect(page.getByText("Number of Boxes")).toBeVisible();
    await expect(page.getByText("Boxes go to the dispatcher for manual truck assignment.")).toBeVisible();
    await expect(page.getByPlaceholder("Width")).toHaveCount(0);
    // selector-ok: the quantity stepper glyph is not a translated string
    await page.getByText("+", { exact: true }).first().click();
    await toConfirmStep(page);

    const ticket = await submitAndReadTicket(page);

    // API agrees: one box line, count 1, no dimensions.
    const trip = await tripByTicket(ticket);
    const cargo = (trip as { cargo_details?: { pallet_type: string; quantity: number; width_ft: unknown; length_ft: unknown }[] }).cargo_details ?? [];
    expect(cargo).toHaveLength(1);
    expect(cargo[0].pallet_type).toBe("box");
    expect(cargo[0].quantity).toBe(1);
    expect(cargo[0].width_ft ?? null).toBeNull();
    expect(cargo[0].length_ft ?? null).toBeNull();
  });

  test("N2. books CUSTOM cargo with width × length in feet", async ({ page }) => {
    await toCargoStep(page);

    await page.getByText("Custom", { exact: true }).click();
    await page.getByPlaceholder("Width").fill("6.5");
    await page.getByPlaceholder("Length").fill("4");
    // Quantity stepper defaults to 1; the manual-assignment hint shows.
    await expect(page.getByText("The dispatcher assigns the truck manually for this cargo.")).toBeVisible();
    await toConfirmStep(page);

    const ticket = await submitAndReadTicket(page);

    const trip = await tripByTicket(ticket);
    const cargo = (trip as { cargo_details?: { pallet_type: string; quantity: number; width_ft: unknown; length_ft: unknown }[] }).cargo_details ?? [];
    expect(cargo).toHaveLength(1);
    expect(cargo[0].pallet_type).toBe("custom");
    expect(cargo[0].quantity).toBe(1);
    expect(Number(cargo[0].width_ft)).toBe(6.5);
    expect(Number(cargo[0].length_ft)).toBe(4);
  });

  test("N3. saves a booking template on Confirm and re-applies it on a new booking", async ({
    page,
  }) => {
    const name = `E2E template ${Date.now() % 100000}`;

    await toCargoStep(page);
    // selector-ok: the quantity stepper glyph is not a translated string
    await page.getByText("+", { exact: true }).first().click(); // 1× first pallet size
    await toConfirmStep(page);

    // Confirm step → save as template.
    await page.getByText("Save as template", { exact: true }).click();
    await expect(page.getByText("Save booking template")).toBeVisible();
    await page.getByPlaceholder("e.g. Weekly Jabil run").fill(name);
    await page.getByText("Save template", { exact: true }).click();
    await expect(page.getByText("Template saved.")).toBeVisible();

    // Submit the booking itself, then start a NEW booking: the saved template
    // must be reachable from Step 1 and prefill the whole wizard when tapped.
    // Rebook and templates now share ONE entry card rather than a button plus a
    // chip row, so the template lives one tap deeper.
    await submitAndReadTicket(page);
    await page.getByText("Back to Dashboard", { exact: true }).click();
    await openBookingForm(page);
    await page.getByText("Start from a previous booking", { exact: true }).click();
    await page.getByText(name, { exact: true }).click();

    // Applying jumps ahead with route/stops/cargo restored — the wizard can now
    // submit without re-entering anything.
    await expect(page.getByText("Review before submitting.")).toBeVisible();
    const ticket2 = await submitAndReadTicket(page);
    expect(ticket2).toBeTruthy();
  });
});

// ── Driver: the K2 document gate (phone layout) ──────────────────────────

test.describe("K2 destination gate (driver, mobile web)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async () => {
    await resetState();
  });

  test("N4. Delivered unlocks only after the Borang K2 document is uploaded", async ({ page }) => {
    // A K2-zone stop, assigned → started → arrived, POD already uploaded: the
    // ONLY thing missing is the K2 document.
    const { adminToken } = { adminToken: (await login(ADMIN)).accessToken };
    const requestor = await login(REQUESTOR);
    const pending = await seedPendingK2Trip(requestor.accessToken);
    await assignToTestDriver(adminToken, pending.id);
    const driver = await driverIdentity(DRIVER);
    await driverStatus(driver.token, pending.id, "start");
    const stopId = pending.stops[0].id;
    await driverStatus(driver.token, pending.id, "arrived", stopId);
    await uploadPod(driver.token, pending.id, stopId, POD_FILE);

    await mobileLogin(page, DRIVER);
    await openActiveTrip(page);

    // POD satisfied, K2 outstanding: the upload button is offered and pressing
    // Delivered must NOT complete the trip (the gate holds).
    await expect(page.getByText(/POD (photo )?uploaded/).first()).toBeVisible();
    await expect(page.getByText(/Upload (Borang K2 form|customs document)/)).toBeVisible();
    // See driver.spec: "Trip Completed!" (trip.completedTitle) is a dead key, so
    // the not-visible assertion below only means something against the real title.
    const completed = page.getByText(/All \d+ stops? delivered/).last();
    // The gate is a LOCK, not a dimmed button: while the customs document is
    // outstanding the footer offers the upload and states why Delivered is
    // unavailable, so there is no bare "Delivered" control to press at all.
    await expect(page.getByText(/Delivered .* the customs document/)).toBeVisible();
    await expect(page.getByText("Delivered", { exact: true })).toHaveCount(0);
    await expect(completed).not.toBeVisible({ timeout: 2500 });

    // Upload the K2 document through the same multipart request the button
    // sends. The upload happened OUTSIDE the page, so reload to refetch the
    // trip → the UI flips to "K2 form uploaded" and Delivered goes through.
    await uploadK2(driver.token, pending.id, stopId, POD_FILE);
    await page.reload();
    await openActiveTrip(page);
    // The gate has opened: the footer advances from the locked row to a real
    // Delivered control.
    await expect(page.getByText("Delivered", { exact: true })).toBeVisible({ timeout: 20_000 });

    // And the document leaves a PERSISTENT mark with a way back. It used to
    // leave none: the upload button is a footer stage that vanishes the moment
    // k2_photo is set, and trip.k2Uploaded was only a toast — so the driver
    // could not confirm the upload had landed, and a wrong or unreadable scan
    // was unfixable, because pressing Delivered moves the trip to
    // pending_approval where the finalize-lock freezes its documents.
    await expect(page.getByText("Customs document uploaded")).toBeVisible();
    await expect(page.getByText("Replace", { exact: true })).toBeVisible();
    await expect(async () => {
      if (await completed.isVisible()) return;
      // force: the live map animates continuously on a real network, so strict
      // stability never settles; the modal + status poll verify the outcome.
      await page.getByText("Delivered", { exact: true }).click({ force: true });
      await expect(completed).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 30_000 });

    // Item-9 approval gate still applies afterwards — the trip proposes, it
    // does not silently pay.
    await expect
      .poll(async () => (await getTrip(driver.token, pending.id)).status)
      .toBe("pending_approval");
  });
});

// ── Exceptions Phase 1 (flag-on: driver sheet → admin lane → requestor) ──

test.describe("Exception workflow (flag-on, all three roles)", () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test.describe("driver (phone)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("N5. report sheet renders the five categories and blocks submit without a photo", async ({
      page,
    }) => {
      const admin = await login(ADMIN);
      const requestor = await login(REQUESTOR);
      const pending = await seedPendingTrip(requestor.accessToken);
      await assignToTestDriver(admin.accessToken, pending.id);
      const driver = await driverIdentity(DRIVER);
      await driverStatus(driver.token, pending.id, "start");

      await mobileLogin(page, DRIVER);
      await openActiveTrip(page);

      await page.getByText("Report a problem", { exact: true }).click();
      await expect(page.getByText("What went wrong?")).toBeVisible();
      for (const cat of ["Customer / Site", "Truck", "Cargo", "External", "Documentation"]) {
        await expect(page.getByText(cat, { exact: true })).toBeVisible();
      }

      // Category + reason but NO photo → the client-side gate blocks it with
      // the photoRequired message (mirrors the server's photo requirement).
      await page.getByText("Truck", { exact: true }).click();
      await page
        .getByPlaceholder(/Anything else the office should know/)
        .fill("e2e validation probe");
      await page.getByText("Tell the office", { exact: true }).click();
      await expect(page.getByText("A photo is required.")).toBeVisible();
    });

    test("N6. a reported exception surfaces on the driver's active trip", async ({ page }) => {
      const admin = await login(ADMIN);
      const requestor = await login(REQUESTOR);
      const pending = await seedPendingTrip(requestor.accessToken);
      await assignToTestDriver(admin.accessToken, pending.id);
      const driver = await driverIdentity(DRIVER);
      await driverStatus(driver.token, pending.id, "start");
      await reportException(driver.token, pending.id, {
        category: "customer_site",
        reason: "E2E-EXC-MARKER gate locked, nobody on site",
        file: POD_FILE,
      });

      await mobileLogin(page, DRIVER);
      await openActiveTrip(page);
      await expect(page.getByText("Exception reported").first()).toBeVisible();
    });
  });

  test("N7. admin lane lists the exception and Verify moves it to Verified", async ({ page }) => {
    const admin = await login(ADMIN);
    const requestor = await login(REQUESTOR);
    const pending = await seedPendingTrip(requestor.accessToken);
    const assigned = await assignToTestDriver(admin.accessToken, pending.id);
    const driver = await driverIdentity(DRIVER);
    await driverStatus(driver.token, pending.id, "start");
    await reportException(driver.token, pending.id, {
      category: "cargo",
      reason: "E2E-EXC-MARKER pallet wrap torn on arrival",
      file: POD_FILE,
    });

    await mobileLogin(page, ADMIN);
    // Wide dashboard → the feature-gated Exceptions entry (dispatch-bar chip;
    // also in the sidebar). The lane's row card previews the driver's reason —
    // the dashboard never renders it, so its visibility proves the lane opened
    // (the ticket number alone would also match the dashboard's Recent Trips).
    await page.getByText("Exceptions", { exact: true }).last().click();
    await expect(page.getByText(/E2E-EXC-MARKER pallet wrap torn/).first()).toBeVisible();
    // The drawer keeps the dashboard mounted underneath (its Recent Trips also
    // holds the ticket, hidden) — scope to the VISIBLE lane card.
    const laneTicket = page.getByText(assigned.ticket_number).filter({ visible: true }).first();
    await expect(laneTicket).toBeVisible();

    // Open the detail modal → Verify → the state chip flips to Verified.
    await laneTicket.click();
    await page.getByText(/^Verify/).first().click();
    await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 15_000 });
  });

  test.describe("requestor (phone)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("N8. requestor sees a redacted exception banner — never the operational detail", async ({
      page,
    }) => {
      const admin = await login(ADMIN);
      const requestor = await login(REQUESTOR);
      const pending = await seedPendingTrip(requestor.accessToken);
      const assigned = await assignToTestDriver(admin.accessToken, pending.id);
      const driver = await driverIdentity(DRIVER);
      await driverStatus(driver.token, pending.id, "start");
      await reportException(driver.token, pending.id, {
        category: "truck",
        reason: "E2E-EXC-MARKER breakdown at KM 12, awaiting tow",
        file: POD_FILE,
      });

      await mobileLogin(page, REQUESTOR);
      // Anchored on "<ticket> · " because only the Bookings card renders that;
      // Home's hero shows a bare ticket and its activity rows "<ticket>
      // delivered", both of which stay mounted under the active scene.
      await page.getByText("Bookings", { exact: true }).first().click();
      await page.getByText(new RegExp(`^${assigned.ticket_number} · `)).first().click();

      // The redacted banner is there…
      await expect(page.getByText("Delivery exception")).toBeVisible();
      // …but the driver's operational reason never reaches a requestor screen
      // (server redaction + the client-side projection, both under test here).
      await expect(page.getByText(/E2E-EXC-MARKER/)).toHaveCount(0);
    });
  });
});

// ── Admin QoL: undo grace window + bulk reject (desktop layout) ──────────

/** MYT calendar date (UTC+8) of an instant, as YYYY-MM-DD. */
function mytDate(instant: number | string | Date): string {
  return new Date(new Date(instant).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The trips board's date filter defaults to TODAY (MYT) only, and every seeded
 * trip picks up TOMORROW — invisible by default. Widen the To input (the last
 * date input holding today's value) so the seeded trips join the board.
 */
async function widenBoardTo(page: Page, toIso: string): Promise<void> {
  const today = mytDate(Date.now());
  await page.locator(`input[value="${today}"]`).last().fill(toIso);
}

test.describe("Admin undo & bulk reject (desktop web)", () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test("N9. unassigning a trip can be undone inside the grace window", async ({ page }) => {
    // A PENDING trip's panel is the dispatch panel (Reject Request only); the
    // UNDOABLE actions (cancel/unassign/abort) live in the monitor panel for
    // assigned/in_progress/approved trips — so exercise the undo via UNASSIGN
    // on an assigned trip.
    const admin = await login(ADMIN);
    const trip = await seedAssignedTrip(admin.accessToken);

    await mobileLogin(page, ADMIN);
    // The WIDE admin shell is a sidebar drawer — the trips board item is
    // "Trip Management" (admin.nav.trips), not the phone tab label "Trips".
    await page.getByText("Trip Management", { exact: true }).first().click();
    await widenBoardTo(page, mytDate(trip.pickup_datetime));
    // The drawer keeps the dashboard mounted underneath (its Recent Trips also
    // holds the ticket, hidden) — filter to the VISIBLE board card.
    await page.getByText(trip.ticket_number).filter({ visible: true }).first().click();

    // Unassign → confirm → the UndoBar floats with a countdown; undo it.
    await page.getByText("Unassign", { exact: true }).first().click();
    await expect(page.getByText("Unassign this trip?")).toBeVisible();
    await page.getByText("Unassign", { exact: true }).last().click();
    await expect(page.getByText(`Unassigning ${trip.ticket_number}…`)).toBeVisible();
    await page.getByText(/^Undo · \d/).click();

    // The scheduled mutation is dropped: the trip must STILL be assigned after
    // the 6s window would have fired.
    await page.waitForTimeout(7_000);
    const after = await getTrip(admin.accessToken, trip.id);
    expect(after.status).toBe("assigned");
  });

  test("N10. bulk-reject clears two selected pending bookings", async ({ page }) => {
    const requestor = await login(REQUESTOR);
    const a = await seedPendingTrip(requestor.accessToken);
    const b = await seedPendingTrip(requestor.accessToken);

    await mobileLogin(page, ADMIN);
    // WIDE sidebar item + date-filter widening (see N9 notes).
    await page.getByText("Trip Management", { exact: true }).first().click();
    await widenBoardTo(page, mytDate(a.pickup_datetime));

    // Enter select mode, tick both pending cards, reject them together.
    await page.getByText("Select", { exact: true }).first().click();
    await page.getByText(a.ticket_number).filter({ visible: true }).first().click();
    await page.getByText(b.ticket_number).filter({ visible: true }).first().click();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByText("Reject selected", { exact: true }).click();
    await expect(page.getByText("Reject 2 bookings?")).toBeVisible();
    await page.getByText("Reject 2", { exact: true }).click();

    await expect
      .poll(async () => (await getTrip(requestor.accessToken, a.id)).status, { timeout: 20_000 })
      .toBe("rejected");
    await expect
      .poll(async () => (await getTrip(requestor.accessToken, b.id)).status, { timeout: 20_000 })
      .toBe("rejected");
  });
});
