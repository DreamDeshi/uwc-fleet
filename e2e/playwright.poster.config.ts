import { defineConfig, devices } from "@playwright/test";

/**
 * THREE POSTER FRAMES at exact print sizes, from the LIVE SDG demo instance.
 *
 * Sizes are produced by viewport × deviceScaleFactor, never by resampling —
 * a viewport screenshot is a real render at that pixel count, so all three
 * land at 300dpi+ in their poster slots:
 *
 *   A  admin dispatch board + live fleet map   1920×1080 @2  → 3840×2160
 *   B  driver active trip + POD capture         480×1040 @3  → 1440×3120
 *   C  requestor booking + tracking            1440× 810 @2  → 2880×1620
 *
 * deviceScaleFactor is a CONTEXT option — it cannot be changed after the fact
 * with setViewportSize — so each frame gets its own project rather than one
 * project that resizes between tests.
 *
 * ⚠ Reads DEMO_WEB_URL and refuses to run without it, so it can never default
 * to localhost or reach production by omission. Same guard as
 * playwright.demoshots.config.ts, and for the same reason.
 *
 * This config takes NO globalSetup: the poster spec must not mutate the demo's
 * seeded state. Its one write is a fresh GPS fix for the truck already on the
 * in-progress trip, because the fleet map draws a LIVE marker only inside
 * GPS_STALE_AFTER_MS (3 minutes) — see the note in posterShots.spec.ts.
 *
 *   DEMO_WEB_URL=https://… DEMO_API_URL=https://… npx playwright test --config playwright.poster.config.ts
 */
const url = process.env.DEMO_WEB_URL;
if (!url) {
  throw new Error("DEMO_WEB_URL is not set — refusing to run poster captures against an unknown target.");
}
if (/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error(`DEMO_WEB_URL points at localhost (${url}) — these captures must come from the deployed demo.`);
}

const base = {
  ...devices["Desktop Chrome"],
  locale: "en-US",
  permissions: ["geolocation"],
  geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
};

export default defineConfig({
  testDir: "./tests",
  testMatch: /posterShots\.spec\.ts/,
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
  },
  projects: [
    {
      name: "A-admin",
      grep: /@shotA/,
      use: { ...base, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
    },
    {
      name: "B-driver",
      grep: /@shotB/,
      // 480px keeps the PHONE layout: useWide flips at WIDE_MIN_WIDTH = 1024.
      use: { ...base, viewport: { width: 480, height: 1040 }, deviceScaleFactor: 3 },
    },
    {
      name: "C-requestor",
      grep: /@shotC/,
      // 1440px is above WIDE_MIN_WIDTH, so this is the desktop shell — which is
      // also the only layout that renders the tracking card beside the details.
      use: { ...base, viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 },
    },
  ],
});
