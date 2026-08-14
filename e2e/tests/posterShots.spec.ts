/**
 * THE THREE POSTER FRAMES, captured from the live SDG demo instance.
 *
 *   A  admin dispatch board + live fleet map   3840×2160  (1920×1080 @2)
 *   B  driver active trip + POD capture        1440×3120  ( 480×1040 @3)
 *   C  requestor booking + tracking            2880×1620  (1440× 810 @2)
 *
 * Every frame is a VIEWPORT screenshot, so the output is a real render at that
 * pixel count — not an upscale — and carries no browser chrome, address bar or
 * OS clock. Each size is asserted from the PNG header after writing, because
 * "it looked right" is not a size check.
 *
 * ── Anonymity ─────────────────────────────────────────────────────────────
 * The demo seeds "Driver 1"…"Driver 8" and synthetic consignees, and its fleet
 * was re-plated to UWC 1001…1009 (the seeded plates are REAL UWC fleet data and
 * cannot appear in public). assertClean() fails the capture if a real plate or a
 * real-looking personal name reaches the frame — the guard has to be on the
 * IMAGE, not on the seed script, because a re-seed silently restores the real
 * plates from docs/uwc-spec.json.
 *
 * ── The one write ─────────────────────────────────────────────────────────
 * Shot A posts a fresh GPS fix for the truck already on the in-progress trip.
 * This is not optional: the admin map draws a LIVE marker only while a fix is
 * newer than GPS_STALE_AFTER_MS (3 minutes, api/src/lib/gpsPosition.ts). A fix
 * from the seed run is stale by the time a browser has booted, and a stale fix
 * renders as a dashed last-known pill with no live dot. Nothing else is
 * created, started or completed — the demo's five-trip state survives.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const PASSWORD = process.env.DEMO_PASSWORD ?? "UwcDemo2026!";
const API = process.env.DEMO_API_URL ?? "https://uwc-api-demo-production.up.railway.app/api/v1";
const ADMIN = "100000001";
const DRIVER = "100000101";   // Driver 1 — holds the in-progress and completed trips
const REQUESTOR = "199990001";

const OUT = path.join(os.homedir(), "Desktop", "poster", "shots");
const REF = path.join(OUT, "_ref");

/** Real UWC plates — the pre-anonymisation fleet. None may appear in a frame. */
const REAL_PLATES = ["PLX 2406", "PND 1888", "PSA 5292", "PPE 1804", "PPE 2406", "PQL 5292", "PRH 5292", "PRJ 5292"];
/** Name shapes that mean the private identity overlay leaked into the demo. */
const REAL_NAME_MARKERS = ["Mohd ", "Mohamad ", "Muhamad ", "Muhammad ", "Amirudin", "Khoo ", "Tan Wei Ming"];

function ensureDirs() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(REF, { recursive: true });
}

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
    await notNow.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    return;
  }
  await notNow.click();
  await notNow.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
}

/** Fail the capture if private fleet or identity data reached the frame. */
async function assertClean(page: Page, where: string) {
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  for (const plate of REAL_PLATES) {
    expect(body, `${where}: real plate "${plate}" is on screen`).not.toContain(plate);
  }
  for (const name of REAL_NAME_MARKERS) {
    expect(body, `${where}: real name "${name.trim()}" is on screen`).not.toContain(name);
  }
}

/** Read a PNG's true pixel size from its IHDR — the only honest size check. */
function pngSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * Stamp a physical resolution into the PNG (pHYs chunk).
 *
 * Playwright writes no pHYs, and a PNG without one is assumed to be 72dpi by
 * every layout tool — so a 3840px-wide frame imports as a 53-inch object that
 * has to be scaled by hand. The pixels are untouched; this only records how
 * big they are meant to be, so the frame drops into a poster slot at 300dpi.
 */
function setPngDpi(file: string, dpi: number) {
  const ppm = Math.round(dpi / 0.0254); // pixels per metre
  const src = fs.readFileSync(file);

  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data.writeUInt8(1, 8); // unit = metres
  const type = Buffer.from("pHYs", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(9, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0, 0);
  const phys = Buffer.concat([len, type, data, crc]);

  // Walk the chunks, drop any existing pHYs, and insert ours before the first
  // IDAT (pHYs must precede the image data).
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

async function shoot(page: Page, file: string, expected: { width: number; height: number }) {
  const full = path.join(OUT, file);
  await page.screenshot({ path: full, fullPage: false });
  setPngDpi(full, 300);
  const got = pngSize(full);
  expect(got, `${file} must be exactly ${expected.width}×${expected.height}`).toEqual(expected);
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${file}  ${got.width}×${got.height} @300dpi`);
}

/** A reference full-page render, for judging framing. Never a deliverable. */
async function reference(page: Page, file: string) {
  await page.screenshot({ path: path.join(REF, file), fullPage: true }).catch(() => {});
}

async function apiLogin(phone: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: `+60${phone}`, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${phone} -> ${res.status}`);
  return (await res.json()).accessToken;
}

/**
 * Put a fresh fix on the in-progress trip so the fleet map shows a LIVE truck.
 * Posted through the same endpoint the driver app uses; creates no trip.
 */
async function freshGpsFix(): Promise<string | null> {
  const adminToken = await apiLogin(ADMIN);
  const trips = await (
    await fetch(`${API}/trips?limit=25`, { headers: { Authorization: `Bearer ${adminToken}` } })
  ).json();
  const rows = Array.isArray(trips) ? trips : trips.data ?? [];
  const active = rows.find((t: { status: string }) => t.status === "in_progress");
  if (!active) return null;

  const driverToken = await apiLogin(DRIVER);
  const res = await fetch(`${API}/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${driverToken}` },
    body: JSON.stringify({
      points: [{ trip_id: active.id, latitude: 5.41, longitude: 100.42 }],
    }),
  });
  if (!res.ok) throw new Error(`POST /locations -> ${res.status} ${await res.text()}`);
  return active.ticket_number;
}

/** Send every scrollable container back to the top. */
async function scrollAllToTop(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((n) => {
      if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = 0;
    });
  });
}

/**
 * The LIVE TRUCK marker.
 *
 * ⚠ Not `.uwc-truck-label` on its own. map.web.tsx gives the PLANT marker that
 * same class (plantIcon, line ~82), and the plant is rendered first — so
 * `.first()` is the plant, always. That mistake panned the map to the plant and
 * then let a "the truck is in frame" assertion pass on a frame with no truck on
 * it: a guard that could not go red.
 */
function truckMarker(page: Page) {
  return page.locator(".uwc-truck-label").filter({ hasNotText: "UWC PLANT" }).first();
}

/** Zoom the fleet map in, about its centre. */
async function zoomFleetMap(page: Page, steps: number) {
  for (let i = 0; i < steps; i++) {
    await page.locator(".leaflet-control-zoom-in").first().click();
    await page.waitForTimeout(1_200);
  }
  await page.waitForTimeout(2_500); // tiles for the new zoom level
}

/**
 * Drag the live truck into the middle of the map's VISIBLE slice.
 *
 * Two things make this fiddly, and both have bitten this spec:
 *  - the drag must START ON BLANK MAP. A mousedown on a Leaflet marker icon
 *    does not begin a map drag, so grabbing the marker itself pans nothing.
 *  - the map card is taller than the frame and its top is scrolled off, so the
 *    map's own centre is NOT the centre of what the camera sees. Aim at the
 *    middle of the intersection of the map and the viewport instead.
 */
async function panTruckIntoFrame(page: Page, attempts = 4): Promise<boolean> {
  const vh = page.viewportSize()!.height;
  for (let i = 0; i < attempts; i++) {
    const mapBox = await page.locator(".leaflet-container").first().boundingBox();
    const tBox = await truckMarker(page).boundingBox();
    if (!mapBox || !tBox) return false;

    const top = Math.max(mapBox.y, 0) + 40;
    const bottom = Math.min(mapBox.y + mapBox.height, vh) - 40;
    const aimX = mapBox.x + mapBox.width / 2;
    const aimY = (top + bottom) / 2;
    const tx = tBox.x + tBox.width / 2;
    const ty = tBox.y + tBox.height;

    if (Math.abs(aimX - tx) < 40 && Math.abs(aimY - ty) < 40) return true;

    // Drag from a blank point inside the visible slice, clamped so both ends of
    // the gesture stay on the map.
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const startX = clamp(aimX - 150, mapBox.x + 30, mapBox.x + mapBox.width - 30);
    const startY = clamp(aimY, top, bottom);
    const endX = clamp(startX + (aimX - tx), mapBox.x + 30, mapBox.x + mapBox.width - 30);
    const endY = clamp(startY + (aimY - ty), top, bottom);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 25 });
    await page.mouse.up();
    await page.waitForTimeout(1_500);
  }
  return true;
}

/**
 * Scroll the RN-web ScrollView so `label` sits `targetY` px below the top of
 * its scroller. RN-web renders ScrollView as an overflow div, so this walks up
 * from the text node to the first actually-scrollable ancestor.
 */
async function scrollLabelTo(page: Page, label: string, targetY: number): Promise<number | null> {
  return page.evaluate(
    ({ label, targetY }) => {
      const el = [...document.querySelectorAll("*")].find(
        (n) => n.children.length === 0 && n.textContent?.trim() === label
      );
      if (!el) return null;
      let s: HTMLElement | null = el.parentElement;
      while (s && s.scrollHeight <= s.clientHeight + 4) s = s.parentElement;
      if (!s) return null;
      const er = el.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      s.scrollTop += er.top - sr.top - targetY;
      return s.scrollTop;
    },
    { label, targetY }
  );
}

// ── A · Admin dispatch board with the live fleet map ──────────────────────
test("@shotA admin dispatch board with live fleet map", async ({ page }) => {
  ensureDirs();

  const ticket = await freshGpsFix();
  // eslint-disable-next-line no-console
  console.log(`  fresh GPS fix posted for ${ticket ?? "(no in-progress trip!)"}`);

  await login(page, ADMIN);

  // The wide dashboard is where the fleet map lives — Trip Management (the
  // literal board) has no map at all. This screen carries the dispatch-mode
  // bar and the awaiting-dispatch count, so it reads as the dispatch board.
  await expect(page.getByText("Fleet Map", { exact: true }).first()).toBeVisible({ timeout: 90_000 });

  // Leaflet needs its tiles; the map also re-invalidates on layout.
  await page.waitForTimeout(6_000);

  // Bring the whole map card on screen first — the zoom control has to be
  // clickable and the map needs blank area to grab.
  await scrollLabelTo(page, "Fleet Map", 30);
  await page.waitForTimeout(2_000);
  await zoomFleetMap(page, 2); // 8 → 10: plant and truck both fit the slice

  // Final framing: anchor on the trips table so the frame carries the live map
  // AND the day's trips. Anchoring on the map card instead pushes Recent Trips
  // to the very bottom edge and the frame shows no trip at all — which is the
  // one thing a dispatch-board photo must not do.
  const top = await scrollLabelTo(page, "Recent Trips", 620);
  // eslint-disable-next-line no-console
  console.log(`  scrolled dashboard to ${top}`);
  await page.waitForTimeout(1_500);

  // Only now is the visible slice of the map known — pan the truck into it.
  await panTruckIntoFrame(page);
  await page.waitForTimeout(2_500);
  await reference(page, "A-dashboard-full.png");

  // A "live fleet map" with no live truck on it is a failed frame, not a
  // stylistic quibble. Log what the locator resolved to: the previous version
  // silently matched the PLANT marker and passed on a truckless frame.
  const markerText = (await truckMarker(page).innerText()).replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-console
  console.log(`  truck marker resolved to: "${markerText}"`);
  expect(markerText, "resolved the plant marker, not a truck").not.toContain("PLANT");
  expect(markerText, "truck marker should carry a synthetic plate").toMatch(/UWC \d{4}/);
  await expect(truckMarker(page), "the live truck marker must be in frame").toBeInViewport({ timeout: 15_000 });

  await assertClean(page, "shot A");
  await shoot(page, "A-admin-dispatch-fleet-map.png", { width: 3840, height: 2160 });
});

// ── B · Driver active trip with the POD capture step ──────────────────────
test("@shotB driver active trip with POD capture", async ({ page }) => {
  ensureDirs();
  await login(page, DRIVER);
  await dismissGpsConsent(page);

  // The seeded in-progress stop is already `arrived`, so the trip screen opens
  // on the POD step natively — "Take POD Photo", 1 of 3 steps done. No camera
  // is driven and nothing is uploaded: expo-image-picker's web path needs a
  // real capture device, and driving it would advance the demo's trip.
  const cont = page.getByText("Continue trip", { exact: true }).first();
  await cont.waitFor({ state: "visible", timeout: 90_000 });
  await cont.click();
  await dismissGpsConsent(page);

  await expect(page.getByText("Take POD Photo", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4_000); // map + stop list settle
  // The body opens part-scrolled, which crops the trip map and hides the back
  // chevron and tracking badge that sit over it.
  await scrollAllToTop(page);
  await page.waitForTimeout(2_000);

  await reference(page, "B-active-trip-full.png");
  await assertClean(page, "shot B");
  await shoot(page, "B-driver-active-trip-pod.png", { width: 1440, height: 3120 });
});

// ── C · Requestor booking with live tracking ──────────────────────────────
test("@shotC requestor booking with tracking", async ({ page }) => {
  ensureDirs();
  await login(page, REQUESTOR);

  // Open the in-progress booking. The Active filter is what makes this
  // unambiguous: manualShots.spec.ts records five failed attempts at aiming the
  // click, every one of which opened the NEIGHBOURING row. Narrowing the list
  // beats aiming better.
  await page.getByText("Bookings", { exact: true }).last().click();
  await page.waitForTimeout(2_000);
  await page.getByText("Active", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2_000);
  await reference(page, "C-bookings-list.png");

  const row = page.getByText(/TKT-/).locator("visible=true").first();
  await row.waitFor({ timeout: 60_000 });
  const card = row.locator('xpath=ancestor::*[@role="button"][1]');
  if (await card.count()) {
    await card.first().click({ timeout: 20_000 }).catch(() => {});
  } else {
    await row.click({ timeout: 20_000 }).catch(() => {});
  }

  await expect(page.getByText("Live Location", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(5_000); // tracking map tiles

  await reference(page, "C-booking-detail-full.png");
  await assertClean(page, "shot C");
  await shoot(page, "C-requestor-booking-tracking.png", { width: 2880, height: 1620 });
});
