import { test, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADMIN, API_BASE, DRIVER, MOBILE_URL, REQUESTOR } from "../helpers/accounts";
import { driverIdentity, driverStatus, login, markStopDocs, uploadPod, type Trip } from "../helpers/api";
import { POD_FILE } from "../helpers/pod";
import { resetState } from "../helpers/reset";
import { pickRouteType, pickSearchableConsignee, seedAssignedTripToday, seedPendingTrip } from "../helpers/seed";
import { dismissGpsConsent, mobileLogin } from "../helpers/ui";

/**
 * THE NINE USER-MANUAL SCREENSHOTS.
 *
 * A capture tool, not a test: it asserts nothing and it must never fail the
 * run. Every shot is individually try/caught, so a screen that breaks is still
 * photographed and the remaining eight are still taken — the existing visual
 * sweep behaves the same way, and for the same reason (a broken screen is
 * exactly what you want a picture of).
 *
 * Output goes to ~/Desktop/pic, deliberately OUTSIDE the repo: these are
 * deliverables for a Word document, not fixtures, and e2e/screenshots is a
 * working folder that gets overwritten by the sweep.
 *
 * ── One trip, its whole life ──────────────────────────────────────────────
 * Shots 04, 05, 06 and 07 need the SAME trip at four different stages, and they
 * are captured in lifecycle order for a reason: seedAssignedTripToday twice for
 * one driver 409s SCHEDULING_CONFLICT (both pickups land inside the conflict
 * window — see the warning on that helper). So one trip is walked forward:
 *
 *   assigned  → shot 05 (driver Home, "Start this trip")
 *   started   → shot 04 (requestor booking detail, Live Location)
 *   arrived   → shot 06 (POD review, if the camera path can be driven)
 *   delivered → shot 07 (driver Earnings, Trip Breakdown)
 *
 * ── Viewports ─────────────────────────────────────────────────────────────
 * deviceScaleFactor 2 throughout so the images stay sharp at Arial 11 body
 * size. Contexts are built per group because deviceScaleFactor is a CONTEXT
 * option — setViewportSize cannot change it after the fact — and because the
 * admin screens need the wide layout while the rest need the phone one.
 */

const OUT = path.join(os.homedir(), "Desktop", "pic");
const PHONE = { width: 390, height: 844 }; // matches screenshots.spec.ts
const DESKTOP = { width: 1440, height: 900 }; // admin dispatch board is wide
const GEO = { latitude: 5.34, longitude: 100.46 }; // Batu Kawan, Penang

/** What actually happened, reported at the end so nothing is silently missing. */
interface Result {
  file: string;
  saved: boolean;
  anchorSeen: boolean;
  anchor: string;
  note?: string;
}
const results: Result[] = [];

/** Empty-state copy: a manual screenshot of an empty screen is worse than none. */
const EMPTY_MARKERS = [
  "No bookings yet",
  "No trips",
  "No earnings logged this week yet.",
  "Nothing to dispatch",
];

async function contextFor(browser: Browser, viewport: { width: number; height: number }) {
  // browser.newContext() does NOT inherit the config's `use` block, so the
  // permissions and geolocation the driver screens need are set here too.
  return browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    locale: "en-US",
    permissions: ["geolocation", "camera"],
    geolocation: GEO,
  });
}

/**
 * Save one image. Best-effort throughout: a missing anchor is recorded, never
 * thrown, so the capture still lands on disk.
 */
async function capture(
  page: Page,
  file: string,
  anchor: string,
  opts: { fullPage?: boolean; scrollTo?: string } = {}
): Promise<void> {
  let anchorSeen = false;
  try {
    await page.getByText(anchor, { exact: false }).first().waitFor({ timeout: 15_000 });
    anchorSeen = true;
  } catch {
    /* capture whatever rendered anyway */
  }

  if (opts.scrollTo) {
    try {
      await page
        .getByText(opts.scrollTo, { exact: false })
        .first()
        .scrollIntoViewIfNeeded({ timeout: 8_000 });
    } catch {
      /* not present — shoot the top of the page */
    }
  }

  await page.waitForTimeout(1_500); // let RN-web finish its enter animation

  const empties: string[] = [];
  for (const marker of EMPTY_MARKERS) {
    // selector-ok: empty-state detection, reported to the operator — not a locator the flow depends on
    if (await page.getByText(marker, { exact: false }).first().isVisible().catch(() => false)) {
      empties.push(marker);
    }
  }

  let saved = false;
  try {
    await page.screenshot({ path: path.join(OUT, file), fullPage: opts.fullPage ?? false });
    saved = true;
  } catch (err) {
    results.push({
      file,
      saved: false,
      anchorSeen,
      anchor,
      note: `screenshot failed: ${(err as Error).message}`,
    });
    return;
  }

  results.push({
    file,
    saved,
    anchorSeen,
    anchor,
    note: empties.length ? `EMPTY STATE on screen: ${empties.join(", ")}` : undefined,
  });
}

/** Bottom-tab labels also appear as headings; the tab bar renders last. */
async function tapTab(page: Page, label: string): Promise<void> {
  await page.getByText(label, { exact: true }).last().click();
}

/**
 * Sign in without ever aborting the run. A capture tool that dies on the fourth
 * of nine screens has thrown away the five it had not reached yet — and a login
 * that fails is itself worth photographing.
 */
async function safeLogin(page: Page, account: { phone: string; password: string }): Promise<void> {
  try {
    await mobileLogin(page, account);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`login as ${account.phone} failed: ${(err as Error).message}`);
  }
}

/**
 * One GPS point for the trip, so the requestor's Live Location map has
 * something to draw. Posted through the same endpoint the driver app uses.
 */
async function postLocation(driverToken: string, tripId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${driverToken}` },
    body: JSON.stringify({
      points: [{ trip_id: tripId, latitude: GEO.latitude, longitude: GEO.longitude }],
    }),
  });
  if (!res.ok) throw new Error(`POST /locations -> ${res.status} ${await res.text()}`);
}

/**
 * Approve the delivered trip's POD so its incentive becomes PAYABLE.
 *
 * Without this the Earnings screen is honest but useless as a manual figure:
 * delivery only PROPOSES an incentive (status pending_approval), so This Week
 * reads "No earnings logged this week yet." and every tile shows 0 while the
 * money sits under "RM x awaiting approval". Approving is what the office does
 * next, and it is what makes the screen show a real week.
 */
async function approveIncentive(adminToken: string, tripId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/trips/${tripId}/approve-incentive`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}), // omit final_amount → confirm the proposal as-is
  });
  if (!res.ok) throw new Error(`PATCH /approve-incentive -> ${res.status} ${await res.text()}`);
}

test("nine user-manual screenshots", async ({ browser }) => {
  test.setTimeout(900_000);
  fs.mkdirSync(OUT, { recursive: true });

  // ── Baseline + fixtures ────────────────────────────────────────────────
  const { adminToken } = await resetState();
  const requestor = await login(REQUESTOR);
  const driver = await driverIdentity(DRIVER);

  // A pending booking: gives the requestor's Current Bookings a row (shot 02)
  // and the admin board something under Awaiting dispatch (shot 08).
  await seedPendingTrip(requestor.accessToken);

  // The lifecycle trip for shots 05 → 04 → 06 → 07.
  let lifecycle: Trip | null = null;
  try {
    lifecycle = await seedAssignedTripToday(adminToken);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`could not seed the assigned trip: ${(err as Error).message}`);
  }

  // ── 01 · Sign in (logged out, phone) ───────────────────────────────────
  let phone = await contextFor(browser, PHONE);
  let page = await phone.newPage();

  /**
   * A signed-OUT phone page.
   *
   * Every role switch needs one, and clearCookies() is NOT enough: this is
   * react-native-web, so the session lives in AsyncStorage — i.e. localStorage —
   * not in a cookie. Reusing the context simply kept the previous role signed
   * in, the login form never rendered, and mobileLogin timed out waiting for a
   * phone-number field that was never going to appear. A new context is the one
   * thing guaranteed to start empty.
   */
  async function freshPhonePage(): Promise<Page> {
    await phone.close();
    phone = await contextFor(browser, PHONE);
    return phone.newPage();
  }

  await page.goto(MOBILE_URL);
  await capture(page, "01-sign-in.png", "Welcome Back");

  // ── 02 · Requestor home ────────────────────────────────────────────────
  await safeLogin(page, REQUESTOR);
  await capture(page, "02-requestor-home.png", "Tap to book a truck", {
    scrollTo: "Current Bookings",
  });

  // ── 03 · Booking wizard, step 1 of 4 (Where) ───────────────────────────
  try {
    const [routeType, consignee] = await Promise.all([
      pickRouteType(requestor.accessToken),
      pickSearchableConsignee(requestor.accessToken),
    ]);
    await page.getByText("Tap to book a truck", { exact: true }).click();
    await page.getByText(routeType.name, { exact: true }).click();
    await page.getByPlaceholder("Type company name, area, or location…").fill(consignee.term);
    try {
      // selector-ok: consignee company name comes from the seeded fixture, not from i18n
      await page.getByText(consignee.display, { exact: true }).first().click({ timeout: 10_000 });
    } catch {
      /* search may not surface it; the step bar is still the subject */
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`booking wizard setup: ${(err as Error).message}`);
  }
  await capture(page, "03-booking-step1.png", "New Trip Request");

  // ── 05 · Driver home with the assigned trip ────────────────────────────
  // Taken BEFORE 04: the trip must still be `assigned` for Home to offer
  // "Start this trip", and 04 needs it started.
  page = await freshPhonePage();
  await safeLogin(page, DRIVER);
  await capture(page, "05-driver-home.png", "Start this trip");

  // ── Advance the trip: started + one GPS point ──────────────────────────
  if (lifecycle) {
    try {
      await driverStatus(driver.token, lifecycle.id, "start");
      await postLocation(driver.token, lifecycle.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`could not start the trip / post a location: ${(err as Error).message}`);
    }
  }

  // ── 04 · Requestor booking detail with the Live Location map ───────────
  page = await freshPhonePage();
  await safeLogin(page, REQUESTOR);
  try {
    await tapTab(page, "Bookings");
    if (lifecycle) {
      const ticket = lifecycle.ticket_number;

      // ⚠ UNSOLVED — 5 attempts, all opened the NEIGHBOURING booking. Read this
      // before trying a sixth.
      //
      // Tried: click(force) · page.mouse.click at the bounding box ·
      // dispatchEvent("click") on the text node · the "Active" filter first ·
      // clicking the row's role="button" ancestor. Every one landed on the trip
      // created immediately BEFORE the target (e.g. wanted -012, opened -011).
      //
      // What is NOT the cause: BookingListScreen wires each row correctly
      // (onPress={() => openTrip(item.id)}), and the target's ticket text IS
      // present and visible each time — the locator never times out.
      //
      // The likely cause, and where a sixth attempt should start: the requestor's
      // list ACCUMULATES bookings across runs (resetState cancels trips, it does
      // not delete them), so the list is long and the "Active" filter did not
      // shorten it the way it should have — a pending trip still came back. That
      // points at the ticket text resolving inside a still-mounted sibling tab
      // screen rather than the visible list, which would make every strategy
      // above aim at the right node in the wrong tree. Verify what
      // getByText(ticket) actually resolves to before aiming again.
      //
      // The capture guard below is what keeps this honest: a detail page for the
      // WRONG trip looks perfectly healthy in a screenshot, and one shipped
      // before the check existed.

      // Opening the right booking took three goes to get right, so both traps
      // are pinned here:
      //
      // 1. VISIBLE ONLY. The Bookings screen renders All / Active / Completed
      //    panes into the DOM together, so the ticket string exists more than
      //    once and .first() could resolve into a HIDDEN pane — whose
      //    coordinates sit over a different card in the visible one.
      // 2. NO force:true. RN-web lays an absolutely-positioned pressable across
      //    each row, so the text node never receives the pointer and an ordinary
      //    click times out. force fixes that but SKIPS the stability wait, and a
      //    click that lands mid-re-render opens the neighbouring booking — it
      //    silently captured the pending trip instead of this one. Clicking the
      //    text's coordinates with the real mouse hits the overlay and bubbles
      //    to the card's onPress, exactly as a finger does.
      // selector-ok: ticket number is fixture data from the API, not i18n copy
      // 0. NARROW THE LIST FIRST. Three attempts at aiming the click precisely
      //    (force, real mouse, dispatchEvent) each opened the NEIGHBOURING
      //    booking. BookingListScreen wires onPress per row correctly
      //    (openTrip(item.id)), so the app is not at fault — the rows are simply
      //    hard to hit individually. The "Active" filter excludes pending, which
      //    leaves this in-progress trip as the ONLY row and removes the
      //    ambiguity instead of trying to aim better.
      await page.getByText("Active", { exact: true }).first().click();
      await page.waitForTimeout(1_500);

      const row = page.getByText(ticket, { exact: false }).locator("visible=true").first();
      await row.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1_000); // let the filtered list settle

      // 3. NO COORDINATES. Clicking the text's centre point kept opening the
      //    NEIGHBOURING booking — twice, once under force and once with the real
      //    mouse. dispatchEvent fires on the exact node that carries OUR ticket
      //    and lets React's delegation bubble it to that card's own handler, so
      //    hit-testing cannot pick a different row. The coordinate click stays
      //    as a fallback for the case where the pressable ignores a bare click.
      const openedRight = async (): Promise<boolean> => {
        try {
          await page.getByText("Booking Details", { exact: true }).waitFor({ timeout: 10_000 });
          // WAIT for the ticket, never isVisible(): that returns immediately and
          // would reject a correct page still painting its badge.
          await page.getByText(ticket, { exact: false }).first().waitFor({ timeout: 8_000 });
          return true;
        } catch {
          return false;
        }
      };

      // PRIMARY: click the row's own pressable ancestor. RN-web renders
      // TouchableOpacity as role="button", so this walks UP from the text node
      // that carries OUR ticket to the exact element whose onPress is
      // openTrip(item.id) — no coordinates, no sibling to hit by mistake.
      // Firing on the text node alone (dispatchEvent) still opened a neighbour.
      const card = row.locator('xpath=ancestor::*[@role="button"][1]');
      if (await card.count()) {
        await card.first().click({ timeout: 10_000 }).catch(() => {});
      }

      if (!(await openedRight())) {
        await page.goto(MOBILE_URL);
        await tapTab(page, "Bookings");
        await page.getByText("Active", { exact: true }).first().click().catch(() => {});
        await page.waitForTimeout(1_500);
        await page
          .getByText(ticket, { exact: false })
          .locator("visible=true")
          .first()
          .dispatchEvent("click")
          .catch(() => {});
      }
      if (!(await openedRight())) {
        await page.goto(MOBILE_URL);
        await tapTab(page, "Bookings");
        const again = page.getByText(ticket, { exact: false }).locator("visible=true").first();
        await again.waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1_500);
        const box = await again.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        if (!(await openedRight())) throw new Error(`opened the wrong booking — wanted ${ticket}`);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`could not open the booking detail: ${(err as Error).message}`);
  }
  await capture(page, "04-booking-detail-live.png", "Live Location", {
    scrollTo: "Live Location",
  });

  // ── 06 · POD review ("Check the photo") ────────────────────────────────
  // The hard one. driver.spec.ts records that headless Chromium never opens a
  // file chooser here: expo-image-picker's web capture path short-circuits with
  // no camera. The config grants `camera` AND hands Chromium a fake device, so
  // this is the best shot available from a browser — but if the review screen
  // never renders we record that and move on rather than failing the run.
  page = await freshPhonePage();
  let podNote: string | undefined;
  try {
    if (!lifecycle) throw new Error("no lifecycle trip was seeded");
    const stopId = lifecycle.stops[0].id;
    await driverStatus(driver.token, lifecycle.id, "arrived", stopId);

    await mobileLogin(page, DRIVER);
    await page.getByText("Continue trip", { exact: true }).click();
    await dismissGpsConsent(page);

    // Hand the picker a real JPEG the instant it asks for one. expo-image-picker's
    // web path ends in an <input type="file">; the `camera` permission gets it
    // past requestCameraPermissionsAsync (which is where driver.spec.ts found it
    // short-circuiting), and this supplies the frame that Chromium's fake device
    // does not actually produce.
    page.on("filechooser", (chooser) => {
      chooser.setFiles(POD_FILE).catch(() => {});
    });

    await page.getByText("Take POD Photo", { exact: true }).click({ timeout: 15_000 });

    // The review screen only exists once a frame has been captured. If no
    // filechooser event fired, drive any file input the picker left in the DOM.
    try {
      await page.getByText("Check the photo", { exact: true }).waitFor({ timeout: 8_000 });
    } catch {
      const input = page.locator('input[type="file"]');
      if (await input.count()) await input.first().setInputFiles(POD_FILE);
      await page.getByText("Check the photo", { exact: true }).waitFor({ timeout: 15_000 });
    }
  } catch (err) {
    podNote = `camera path could not be driven from Chromium: ${(err as Error).message}`;
    // eslint-disable-next-line no-console
    console.warn(`06 POD review: ${podNote}`);
  }
  await capture(page, "06-pod-photo-check.png", "Check the photo");
  if (podNote) {
    const r = results.find((x) => x.file === "06-pod-photo-check.png");
    if (r && !r.anchorSeen) r.note = podNote;
  }

  // ── Finish the trip so Earnings has a completed row ────────────────────
  if (lifecycle) {
    try {
      const stopId = lifecycle.stops[0].id;
      await uploadPod(driver.token, lifecycle.id, stopId, POD_FILE);
      await markStopDocs(driver.token, lifecycle.id, stopId, { k2_form_ack: true });
      await driverStatus(driver.token, lifecycle.id, "delivered", stopId);
      // Delivery only PROPOSES the incentive. Without the office's approval the
      // Earnings screen shows RM 0 and "No earnings logged this week yet.",
      // which is a truthful screenshot of a useless week.
      await approveIncentive(adminToken, lifecycle.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`could not complete the trip: ${(err as Error).message}`);
    }
  }

  // ── 07 · Driver earnings ───────────────────────────────────────────────
  page = await freshPhonePage();
  await safeLogin(page, DRIVER);
  try {
    await tapTab(page, "My Stats");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`could not open My Stats: ${(err as Error).message}`);
  }
  // Anchor on "This Week", not earnings.title ("My Earnings"): the screen's
  // header reads "My Stats" with Earnings/Score tabs beneath it, so the title
  // key never renders here and anchoring on it reported a false miss.
  // fullPage: This Week and Trip Breakdown do not share one 844px viewport.
  await capture(page, "07-earnings.png", "This Week", {
    fullPage: true,
    scrollTo: "Trip Breakdown",
  });
  await phone.close();

  // ── 08 / 09 · Administrator, wide layout ───────────────────────────────
  const desktop = await contextFor(browser, DESKTOP);
  const adminPage = await desktop.newPage();
  await safeLogin(adminPage, ADMIN);
  // ⚠ The manual asks for "Today's dispatch", but that card is PHONE-layout copy
  // (AdminHomeScreen). At the >=1024px width this shot is specified at, the admin
  // lands on the wide dashboard instead — "Live fleet overview" — which carries
  // the same information under different labels (Dispatch Mode, "n awaiting
  // manual dispatch", Trips today / in progress / done). The anchor matches what
  // this viewport can actually render, so the report stays truthful.
  await capture(adminPage, "08-admin-dashboard.png", "Live fleet overview");

  try {
    await adminPage.getByText("Reports", { exact: true }).first().click();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`could not open Reports: ${(err as Error).message}`);
  }
  await capture(adminPage, "09-admin-reports.png", "Driver Payroll", {
    scrollTo: "Export CSV",
  });
  await desktop.close();

  // ── Report ─────────────────────────────────────────────────────────────
  const lines = results.map((r) => {
    const state = !r.saved ? "NOT SAVED" : r.anchorSeen ? "ok" : "SAVED, ANCHOR MISSING";
    return `  ${r.file.padEnd(28)} ${state.padEnd(22)} anchor="${r.anchor}"${
      r.note ? `\n      ⚠ ${r.note}` : ""
    }`;
  });
  // eslint-disable-next-line no-console
  console.log(
    ["", `Manual screenshots → ${OUT}`, ...lines, "", `${results.filter((r) => r.saved).length}/9 files written`, ""].join(
      "\n"
    )
  );
  fs.writeFileSync(path.join(OUT, "_capture-report.json"), JSON.stringify(results, null, 2));
});
