import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the UWC Fleet e2e suite.
 *
 * Targets are env-driven (see helpers/accounts.ts): by default the suite
 * points at LOCAL dev servers; running against the deployed Railway apps
 * requires the explicit E2E_ALLOW_PROD=1 opt-in because the per-spec reset
 * modifies real data. The three targets (mobile web for requestor + driver,
 * admin dashboard) share one API, so per-test isolation is done in code
 * (see helpers/reset.ts), not by spinning up fresh servers.
 *
 * Tests run serially (workers: 1). They share a single backend and a single
 * driver account whose "one active trip" rule makes parallel trip assignment
 * race against itself; serial execution keeps each spec's reset deterministic.
 */
export default defineConfig({
  testDir: "./tests",
  // A cold Railway dyno + RN-web bundle can be slow on first paint.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Force English so the i18n text selectors match, and a desktop viewport so
    // the admin SPA renders the full dashboard instead of redirecting to its
    // mobile-lite (/m) view.
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    // The driver ActiveTrip screen reads GPS; grant a fixed fix so the map/location
    // hooks don't stall waiting on a permission prompt.
    permissions: ["geolocation"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
