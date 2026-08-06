import { defineConfig, devices } from "@playwright/test";

/**
 * Poster captures from the LIVE SDG demo instance.
 *
 * Deliberately separate from every other config:
 *   - playwright.config.ts runs globalSetup/globalTeardown and its specs call
 *     resetState(), which MUTATES data. This one has neither, and never writes.
 *   - playwright.shots.config.ts serves /api/v1/** from fixtures. This one wants
 *     the real thing: the whole point is a capture of the deployed demo.
 *
 * ⚠ Reads DEMO_WEB_URL from the environment and refuses to run without it, so
 * it can never default to localhost or be pointed at production by omission.
 *
 * Read-only: it logs in and navigates. It creates no booking and completes no
 * delivery, so the demo's clean five-trip state survives the run.
 *
 *   DEMO_WEB_URL=https://… DEMO_PASSWORD=… npx playwright test --config playwright.demoshots.config.ts
 */
const url = process.env.DEMO_WEB_URL;
if (!url) {
  throw new Error(
    "DEMO_WEB_URL is not set — refusing to run poster captures against an unknown target."
  );
}
if (/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error(`DEMO_WEB_URL points at localhost (${url}) — these captures must come from the deployed demo.`);
}

export default defineConfig({
  testDir: "./tests",
  testMatch: /demoShots\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: url,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    locale: "en-US",
    permissions: ["geolocation"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  projects: [
    // Admin is a desktop tool — the dispatch board only shows its two-column
    // layout above the `wide` breakpoint.
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
      testMatch: /demoShots\.spec\.ts/,
      grep: /@desktop/,
    },
    // Driver screens are drawn at 390×844.
    {
      name: "phone",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
      testMatch: /demoShots\.spec\.ts/,
      grep: /@phone/,
    },
  ],
});
