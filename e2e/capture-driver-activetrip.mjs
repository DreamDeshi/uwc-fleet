/**
 * CAPTURE-ONLY: one anonymous driver Active Trip frame from the DEPLOYED DEMO,
 * for the poster. Read-only — it logs in, opens the in-progress trip and
 * photographs it. It never drives trip state, so the demo is left exactly as
 * the viva will find it.
 *
 *   node capture-driver-activetrip.mjs <out-dir>
 *
 * Refuses localhost: an anonymous frame must come from the anonymous instance,
 * and a local stack could be seeded from the private refs.
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const URL = process.env.DEMO_WEB_URL ?? "https://uwc-mobile-demo-production.up.railway.app";
const PASSWORD = process.env.DEMO_PASSWORD ?? "UwcDemo2026!";
const DRIVER = "+60100000101";
const OUT = path.resolve(process.argv[2] ?? ".");

if (/localhost|127\.0\.0\.1/.test(URL)) {
  throw new Error(`DEMO_WEB_URL points at localhost (${URL}) — this frame must come from the demo.`);
}

// Anything that would betray the real fleet or a real person. The demo is
// seeded anonymously, but the guard lives on the IMAGE because a re-seed can
// silently restore real plates (see the demo-fleet re-plating note).
const FORBIDDEN = [
  "PLX 2406", "PND 1888", "PSA 5292", "PPE 1804", "PPE 2406",
  "PQL 5292", "PRH 5292", "PRJ 5292",
  "Mohd ", "Mohamad ", "Muhamad ", "Muhammad ", "Amirudin", "Khoo ", "Tan Wei Ming",
];

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 }, // ×3 = 1290×2796, the phone's own size
    deviceScaleFactor: 3,
    locale: "en-US",
    permissions: ["geolocation"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan
  });
  const page = await ctx.newPage();

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("12-345 6789").fill(DRIVER.replace(/^\+60/, ""));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByText("Sign In", { exact: true }).click();

  // Into the running trip. Either label can be showing depending on state.
  const enter = page.getByText(/Continue trip|Start this trip/).first();
  await enter.waitFor({ timeout: 60_000 });
  await enter.click();

  // ACCEPT the GPS consent, don't dismiss it. Declining leaves the screen
  // showing a red "Location off · Tap to enable" pill, which is a picture of
  // the app in a degraded state — the opposite of what a poster frame wants.
  const enable = page.getByText("Enable Location", { exact: true });
  try {
    await enable.waitFor({ state: "visible", timeout: 8_000 });
    await enable.click();
    await enable.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
  } catch {
    /* consent already answered for this session */
  }

  await page.getByText(/STOP \d+ OF \d+/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000); // let map tiles land

  const text = await page.evaluate(() => document.body.innerText);
  const leaked = FORBIDDEN.filter((f) => text.includes(f));
  if (leaked.length) {
    throw new Error(`REFUSING TO SAVE — real fleet/person data on screen: ${leaked.join(", ")}`);
  }

  const file = path.join(OUT, "driver-active-trip-demo.png");
  await page.screenshot({ path: file });
  console.log(`\nsaved ${file}`);
  console.log(`\n--- what is on the frame ---\n${text.slice(0, 700)}`);

  await browser.close();
};

main().catch((e) => { console.error(e.message); process.exit(1); });
