import { defineConfig, devices } from "@playwright/test";

/**
 * FOUR DRIVER SCREENS at one exact print size, from the LIVE demo instance.
 *
 *   430×932 @ deviceScaleFactor 3  →  1290×2796 per file
 *
 * 430px keeps the PHONE layout (useWide flips at WIDE_MIN_WIDTH = 1024), and
 * the size comes from viewport × DSF — a real render at that pixel count, never
 * a resample.
 *
 * ⚠ UNLIKE playwright.poster.config.ts, THIS SPEC MUTATES THE DEMO. Three of
 * the four screens only exist part-way through a delivery (a delivered stop, a
 * stop sitting at the POD step, a finalized pay breakdown), so the spec walks
 * the seeded in-progress trip forward through the real API rather than
 * inventing the states in the database — the pay breakdown in particular is the
 * SERVER'S finalize-time evidence, and fabricating `points_awarded` would put
 * invented money on a poster. Restore the demo afterwards with the documented
 * re-seed + re-plate.
 *
 * Runs serially in declaration order: each test performs the transition its own
 * screen needs, so the order is load-bearing.
 *
 *   DEMO_WEB_URL=https://… npx playwright test --config playwright.driverscreens.config.ts
 */
const url = process.env.DEMO_WEB_URL;
if (!url) {
  throw new Error("DEMO_WEB_URL is not set — refusing to run driver captures against an unknown target.");
}
if (/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error(`DEMO_WEB_URL points at localhost (${url}) — these captures must come from the deployed demo.`);
}

export default defineConfig({
  testDir: "./tests",
  testMatch: /driverScreens\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: url,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    ...devices["Desktop Chrome"],
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    locale: "en-US",
    permissions: ["geolocation"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  projects: [{ name: "driver" }],
});
