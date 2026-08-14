/**
 * FOUR DRIVER SCREENS from the live demo instance, all 1290×2796
 * (430×932 @ deviceScaleFactor 3).
 *
 *   1  trip list            — several trips, one in progress
 *   2  active trip          — stop 1 delivered, stop 2 pending, route on the map
 *   3  stop at the POD step — "Take POD Photo", delivery not yet unlocked
 *   4  pay breakdown        — points per drop, deduction, total points, rate
 *
 * ── Why this one writes ───────────────────────────────────────────────────
 * Three of these four states do not exist on a freshly seeded demo. Rather than
 * writing them into the database, the spec walks the seeded in-progress trip
 * forward through THE SAME API THE DRIVER APP USES. That matters most for shot
 * 4: `buildPayBreakdown` renders only from the server's finalize-time evidence
 * (`points_awarded`, `was_repeat`, `deduction_applied`, `rate_used`), so hand-
 * writing those columns would be putting invented money on a poster. Let the
 * incentive engine compute it and photograph what it produced.
 *
 * The demo is left mid-lifecycle by design; restore it with the documented
 * re-seed (clearing TripStatusHistory / TripChangeRequest / TripException
 * first) followed by the re-plate.
 *
 * Order is load-bearing: each test performs the transition its screen needs.
 *
 * ── Anonymity ─────────────────────────────────────────────────────────────
 * assertClean() fails the capture if a real UWC plate or a real-looking
 * personal name reaches the frame. The demo's fleet was re-plated to
 * UWC 1001–1009; a re-seed silently restores the real plates, so the guard
 * lives on the IMAGE rather than on the seed.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const PASSWORD = process.env.DEMO_PASSWORD ?? "UwcDemo2026!";
const API = process.env.DEMO_API_URL ?? "https://uwc-api-demo-production.up.railway.app/api/v1";
const ADMIN = "+60100000001";
const DRIVER = "+60100000101"; // Driver 1 — holds the assigned, in-progress and completed trips

const OUT = path.join(os.homedir(), "Desktop", "poster", "driver-screens");
const SIZE = { width: 1290, height: 2796 };

const REAL_PLATES = ["PLX 2406", "PND 1888", "PSA 5292", "PPE 1804", "PPE 2406", "PQL 5292", "PRH 5292", "PRJ 5292"];
const REAL_NAME_MARKERS = ["Mohd ", "Mohamad ", "Muhamad ", "Muhammad ", "Amirudin", "Khoo ", "Tan Wei Ming"];

/** A valid 1×1 JPEG. No screen in this set renders the POD image itself — the
 *  gate only needs a real image to exist behind the flag. */
const POD_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64"
);

// ── API ───────────────────────────────────────────────────────────────────
async function apiLogin(phone: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${phone} -> ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

interface Stop { id: string; sequence: number; status: string; consignee?: { company_name?: string; zone_code?: string } }
interface Trip { id: string; ticket_number: string; status: string; stops: Stop[] }

async function getJson(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** The driver's current in-progress trip, with its stops in sequence. */
async function inProgressTrip(token: string): Promise<Trip> {
  const list = await getJson(`${API}/trips?limit=25`, token);
  const rows = Array.isArray(list) ? list : list.data ?? [];
  const row = rows.find((t: { status: string }) => t.status === "in_progress");
  if (!row) throw new Error("no in-progress trip on the demo — re-seed it first");
  const full = (await getJson(`${API}/trips/${row.id}`, token)) as Trip;
  full.stops = [...full.stops].sort((a, b) => a.sequence - b.sequence);
  return full;
}

/**
 * The trip shot 4 photographs: the one still out on the road if there is one,
 * otherwise the finished multi-drop trip this spec already walked. Needed
 * because shot 4 is the only test that can be re-run AFTER its own transition —
 * by then the trip is completed and an in-progress lookup finds nothing.
 */
async function tripForBreakdown(token: string): Promise<Trip> {
  const list = await getJson(`${API}/trips?limit=25`, token);
  const rows = Array.isArray(list) ? list : list.data ?? [];
  const live = rows.find((t: { status: string }) => t.status === "in_progress");
  if (live) {
    const full = (await getJson(`${API}/trips/${live.id}`, token)) as Trip;
    full.stops = [...full.stops].sort((a, b) => a.sequence - b.sequence);
    return full;
  }
  const finished = rows.filter((t: { status: string }) =>
    t.status === "completed" || t.status === "pending_approval"
  );
  const full = await Promise.all(
    finished.map((t: { id: string }) => getJson(`${API}/trips/${t.id}`, token) as Promise<Trip>)
  );
  // The multi-drop one — the single-stop seeded trip has no per-drop evidence.
  const withPoints = full
    .filter((t) => (t.stops ?? []).some((s) => (s as { points_awarded?: number }).points_awarded != null))
    .sort((a, b) => (b.stops?.length ?? 0) - (a.stops?.length ?? 0))[0];
  if (!withPoints) throw new Error("no trip carries per-drop pay evidence — re-seed and re-run in order");
  withPoints.stops = [...withPoints.stops].sort((a, b) => a.sequence - b.sequence);
  return withPoints;
}

async function uploadPod(token: string, tripId: string, stopId: string) {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array(POD_JPEG)], { type: "image/jpeg" }), "pod.jpg");
  const res = await fetch(`${API}/trips/${tripId}/stops/${stopId}/pod`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }, // no Content-Type: fetch sets the boundary
    body: form,
  });
  if (!res.ok) throw new Error(`POST pod -> ${res.status} ${await res.text()}`);
}

async function driverAction(token: string, tripId: string, action: "arrived" | "delivered", stopId: string) {
  const res = await fetch(`${API}/trips/${tripId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, stop_id: stopId }),
  });
  if (!res.ok) throw new Error(`PATCH status ${action} -> ${res.status} ${await res.text()}`);
}

/** POD then delivered — the documentation gate rejects delivery without one. */
async function deliverStop(token: string, tripId: string, stop: Stop) {
  if (stop.status !== "arrived") await driverAction(token, tripId, "arrived", stop.id);
  await uploadPod(token, tripId, stop.id);
  await driverAction(token, tripId, "delivered", stop.id);
}

/** Confirm the engine's proposal as-is, so the breakdown reads as settled pay. */
async function approveIncentive(adminToken: string, tripId: string) {
  const res = await fetch(`${API}/trips/${tripId}/approve-incentive`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`PATCH approve-incentive -> ${res.status} ${await res.text()}`);
}

// ── Page helpers ──────────────────────────────────────────────────────────
async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("12-345 6789").fill(DRIVER.replace("+60", ""));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByText("Sign In", { exact: true }).click();
}

async function dismissGpsConsent(page: Page) {
  const notNow = page.getByText("Not now", { exact: true });
  try {
    await notNow.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    return;
  }
  await notNow.click();
  await notNow.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
}

async function assertClean(page: Page, where: string) {
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  for (const plate of REAL_PLATES) {
    expect(body, `${where}: real plate "${plate}" is on screen`).not.toContain(plate);
  }
  for (const name of REAL_NAME_MARKERS) {
    expect(body, `${where}: real name "${name.trim()}" is on screen`).not.toContain(name);
  }
}

function pngSize(file: string) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Record 300dpi in the PNG, so the file imports at print size, not at 72dpi. */
function setPngDpi(file: string, dpi: number) {
  const ppm = Math.round(dpi / 0.0254);
  const src = fs.readFileSync(file);
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data.writeUInt8(1, 8);
  const type = Buffer.from("pHYs", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(9, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0, 0);
  const phys = Buffer.concat([len, type, data, crc]);

  const out: Buffer[] = [src.subarray(0, 8)];
  let i = 8;
  let inserted = false;
  while (i < src.length) {
    const size = src.readUInt32BE(i);
    const name = src.subarray(i + 4, i + 8).toString("latin1");
    const chunk = src.subarray(i, i + 12 + size);
    if (name === "IDAT" && !inserted) {
      out.push(phys);
      inserted = true;
    }
    if (name !== "pHYs") out.push(chunk);
    i += 12 + size;
  }
  fs.writeFileSync(file, Buffer.concat(out));
}

async function shoot(page: Page, file: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const full = path.join(OUT, file);
  await page.screenshot({ path: full, fullPage: false });
  setPngDpi(full, 300);
  expect(pngSize(full), `${file} must be exactly ${SIZE.width}×${SIZE.height}`).toEqual(SIZE);
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${file}  ${SIZE.width}×${SIZE.height} @300dpi`);
}

/** Send every scrollable container back to the top. */
async function scrollAllToTop(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((n) => {
      if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = 0;
    });
  });
}

// ── 1 · Trip list ─────────────────────────────────────────────────────────
test("1 driver trip list", async ({ page }) => {
  const driverToken = await apiLogin(DRIVER);
  const trip = await inProgressTrip(driverToken);
  // eslint-disable-next-line no-console
  console.log(`  in-progress trip ${trip.ticket_number}, ${trip.stops.length} stops`);

  await login(page);
  await dismissGpsConsent(page);
  await page.getByText("Trips", { exact: true }).last().click();
  await page.waitForTimeout(3_000);
  await scrollAllToTop(page);

  // Driver 1 holds an assigned, an in-progress and a completed trip. An empty
  // list is the one thing this frame must not be.
  const tickets = await page.getByText(/TKT-\d{8}-\d+/).count();
  expect(tickets, "trip list must show at least two trips").toBeGreaterThanOrEqual(2);
  // The "Continue · stop n of m" button is rendered only for an in_progress
  // trip (TripListScreen: `live`), so it is the honest in-progress signal here —
  // more reliable than the status pill's wording.
  await expect(page.getByText(/Continue · stop \d+ of \d+/).first()).toBeVisible({ timeout: 30_000 });

  await assertClean(page, "shot 1");
  await shoot(page, "1-driver-trip-list.png");
});

// ── 2 · Active trip: one stop delivered, the next still to go ─────────────
test("2 active trip stop list", async ({ page }) => {
  const driverToken = await apiLogin(DRIVER);
  const trip = await inProgressTrip(driverToken);

  // Deliver stop 1 through the real API (POD, then delivered) so the stop list
  // shows a genuinely completed drop and the map draws the leg behind it.
  const first = trip.stops[0];
  if (first.status !== "delivered") {
    await deliverStop(driverToken, trip.id, first);
    // eslint-disable-next-line no-console
    console.log(`  delivered stop 1 (${first.consignee?.company_name})`);
  }

  await login(page);
  await dismissGpsConsent(page);
  await page.getByText("Continue trip", { exact: true }).first().click();
  await dismissGpsConsent(page);
  await page.waitForTimeout(5_000); // map legs + stop list
  await scrollAllToTop(page);
  await page.waitForTimeout(2_000);

  // "1 delivered" of 3, with stops still to run.
  await expect(page.getByText(/1 delivered/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/STOPS LEFT/i).first()).toBeVisible({ timeout: 30_000 });

  await assertClean(page, "shot 2");
  await shoot(page, "2-active-trip-stop-list.png");
});

// ── 3 · The stop sitting at the POD step ──────────────────────────────────
test("3 stop at the POD capture step", async ({ page }) => {
  const driverToken = await apiLogin(DRIVER);
  const trip = await inProgressTrip(driverToken);

  // Arriving at stop 2 moves the footer from "Arrived at Pickup" to
  // "Take POD Photo". Delivery stays unavailable until the photo exists — the
  // documentation gate is server-side (isDocumentationComplete).
  const next = trip.stops.find((s) => s.status !== "delivered");
  if (!next) throw new Error("every stop is already delivered — re-seed the demo");
  if (next.status !== "arrived") {
    await driverAction(driverToken, trip.id, "arrived", next.id);
    // eslint-disable-next-line no-console
    console.log(`  arrived at stop ${next.sequence} (${next.consignee?.company_name})`);
  }

  await login(page);
  await dismissGpsConsent(page);
  await page.getByText("Continue trip", { exact: true }).first().click();
  await dismissGpsConsent(page);
  await page.waitForTimeout(5_000);
  await scrollAllToTop(page);
  await page.waitForTimeout(2_000);

  await expect(page.getByText("Take POD Photo", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The step meter is what says the stop is not finished: 1 of 3 done, and
  // Delivered is not offered.
  await expect(page.getByText(/of 3 steps done/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Delivered", { exact: true })).toHaveCount(0);

  await assertClean(page, "shot 3");
  await shoot(page, "3-stop-pod-capture.png");
});

// ── 4 · Pay breakdown: points per drop and the total ──────────────────────
test("4 earnings pay breakdown", async ({ page }) => {
  const driverToken = await apiLogin(DRIVER);
  const adminToken = await apiLogin(ADMIN);
  const trip = await tripForBreakdown(driverToken);

  // Finish the trip. The last delivery is what finalizes it: the engine writes
  // points_awarded per drop, the deduction and the rate, which is the only
  // thing buildPayBreakdown will render.
  for (const stop of trip.stops) {
    if (stop.status !== "delivered") {
      await deliverStop(driverToken, trip.id, stop);
      // eslint-disable-next-line no-console
      console.log(`  delivered stop ${stop.sequence} (${stop.consignee?.company_name})`);
    }
  }
  // Idempotent: a re-run finds the trip already approved and the endpoint 4xxs.
  try {
    await approveIncentive(adminToken, trip.id);
    // eslint-disable-next-line no-console
    console.log(`  approved the incentive on ${trip.ticket_number}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`  incentive already settled (${(err as Error).message.slice(0, 60)}…)`);
  }

  await login(page);
  await dismissGpsConsent(page);

  // ⚠ Reach the breakdown through the TRIPS tab, not the earnings list. The
  // earnings row renders `destination ?? ticket_number` — the destination, so
  // the ticket string is NOT on that screen and a getByText(ticket) click
  // silently fell through to the headline RM total and never navigated.
  // The trip card's meta line does carry the ticket.
  await page.getByText("Trips", { exact: true }).last().click();
  await page.waitForTimeout(2_500);
  // Narrow to Completed first: aiming at one row in a longer list is what cost
  // manualShots five attempts.
  await page.getByText("Completed", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2_000);

  const row = page.getByText(trip.ticket_number, { exact: false }).locator("visible=true").first();
  await row.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_500); // let the filtered list settle before aiming

  // ⚠ An ordinary .click() on the ticket text FAILS here: RN-web lays an
  // absolutely-positioned pressable across the card, so the text node never
  // receives the pointer ("subtree intercepts pointer events"). TripCard also
  // exposes no role="button" ancestor to climb to. Clicking the row's
  // COORDINATES with the real mouse hits that overlay and bubbles to the card's
  // onPress — exactly as a finger does. Same conclusion manualShots reached.
  const arrived = async () =>
    page
      .getByText("Pay Breakdown", { exact: true })
      .waitFor({ timeout: 12_000 })
      .then(() => true)
      .catch(() => false);

  const box = await row.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  if (!(await arrived())) {
    // Fallback: fire on the exact node carrying OUR ticket and let React's
    // delegation bubble it to that card's own handler.
    await row.dispatchEvent("click").catch(() => {});
  }
  expect(await arrived(), `never reached the trip details for ${trip.ticket_number}`).toBe(true);

  await expect(page.getByText("Pay Breakdown", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Total points", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Points per drop — one row per delivered stop.
  const ptRows = await page.getByText(/\d+ pt\(s\)/).count();
  expect(ptRows, "breakdown must list points per drop").toBeGreaterThanOrEqual(3);

  await page.getByText("Pay Breakdown", { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_500);

  await assertClean(page, "shot 4");
  await shoot(page, "4-earnings-pay-breakdown.png");
});
