import { defineConfig, devices } from "@playwright/test";

/**
 * Visual-only config for the driver Home captures.
 *
 * Deliberately separate from `playwright.config.ts`: that one runs globalSetup /
 * globalTeardown against a real backend and its specs call `resetState()`, which
 * MUTATES data. This config has no setup, no teardown, and its spec serves every
 * `/api/v1/**` call from fixtures — so it needs no API, no database, and can
 * never touch prod.
 *
 * Phone viewport, because the design frames are 390×844 and Home is the phone
 * layout. Run:
 *   npx playwright test --config playwright.shots.config.ts
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /(driverHomeShots|overlaySweepShots)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    locale: "en-US",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    permissions: ["geolocation"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  // The device descriptor carries its own 1280×720 viewport, so it must be
  // spread BEFORE the phone size or Home renders in the wide centred column
  // instead of the 390px layout the design draws.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
    },
  ],
});
