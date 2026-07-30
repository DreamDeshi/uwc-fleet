import { defineConfig, devices } from "@playwright/test";

/**
 * Visual + measurement config for the Profile language switcher.
 *
 * Separate from `playwright.config.ts` for the same reason as
 * playwright.shots.config.ts: that one runs globalSetup/globalTeardown against a
 * real backend and its specs call `resetState()`, which MUTATES data. This has
 * no setup, no teardown, and its spec serves every `/api/v1/**` call from
 * fixtures — no API, no database, and it can never touch prod.
 *
 * The spec sets its own viewport per test (390 narrow / 1440 wide), so the
 * viewport here is only the starting size.
 *
 *   npx playwright test --config playwright.lang.config.ts
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /languageSwitcherShots\.spec\.ts/,
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
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
    },
  ],
});
