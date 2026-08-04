import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the UWC Fleet e2e suite.
 *
 * Targets are env-driven (see helpers/accounts.ts): by default the suite
 * points at LOCAL dev servers; running against the deployed Railway apps
 * requires the explicit E2E_ALLOW_PROD=1 opt-in because the per-spec reset
 * modifies real data. The mobile web app (requestor, driver, and role-routed
 * admin) and the API share one backend, so per-test isolation is done in code
 * (see helpers/reset.ts), not by spinning up fresh servers.
 *
 * Tests run serially (workers: 1). They share a single backend and a single
 * driver account whose "one active trip" rule makes parallel trip assignment
 * race against itself; serial execution keeps each spec's reset deterministic.
 */
export default defineConfig({
  testDir: "./tests",
  // uiAuditSweep is a CAPTURE tool, not a check: it walks every screen in three
  // languages at two widths, writes ~90 PNGs and a findings JSON, and asserts
  // nothing. Three minutes of CI that can never fail is three minutes wasted, so
  // it runs on demand via playwright.audit.config.ts. The assertions it led to
  // live in tabLabelBox.spec.ts and i18nLayoutSweep.spec.ts, which DO run here.
  testIgnore: /uiAuditSweep\.spec\.ts/,
  // Capture the backend's dispatch_mode before the run and restore that exact
  // value after — resetState() flips it to manual per spec and a prod run once
  // left the live trial that way.
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
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
    // the responsive web app renders its wide layout (the admin screens use it).
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    // The driver ActiveTrip screen reads GPS; grant a fixed fix so the map/location
    // hooks don't stall waiting on a permission prompt. Camera is granted for the
    // POD-photo capture: expo-image-picker's launchCameraAsync gates on
    // requestCameraPermissionsAsync first, which headless Chromium denies by
    // default, short-circuiting before the file input opens — a real device has
    // a camera, so this models it rather than manufacturing a pass.
    permissions: ["geolocation", "camera"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
