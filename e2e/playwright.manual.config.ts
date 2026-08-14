import { defineConfig, devices } from "@playwright/test";

/**
 * CAPTURE-ONLY config for the user-manual screenshots (manualShots.spec.ts).
 *
 * Separate from `playwright.config.ts` for the same reason the audit and shots
 * configs are: this is a capture tool, not a check. It asserts nothing, it
 * writes outside the repo (~/Desktop/pic), and it must never run in CI — a job
 * that can only ever be green is a job that tells you nothing.
 *
 * It DOES keep globalSetup/globalTeardown, which are not optional here:
 *   - setup normalises all three shared accounts to English, and every selector
 *     in the spec is English copy. An earlier aborted run once left the accounts
 *     in Chinese and the next run failed against labels that no longer existed.
 *   - setup widens the fixture truck's operating window for the run (restoring
 *     it in teardown). Without it, seeding a today-scheduled assigned trip 409s
 *     OPERATING_WINDOW for roughly a fifth of the day.
 *
 * Run:
 *   npx playwright test --config playwright.manual.config.ts
 *
 * The fake-media-stream flags are here for shot 06 (the POD review screen).
 * expo-image-picker's web capture path gates on a camera being present, and
 * headless Chromium has none — driver.spec.ts records that the file chooser
 * never opens at all. Granting the `camera` permission is necessary but was not
 * sufficient on its own, so these flags hand Chromium a synthetic device too.
 * If the review screen still never renders, the spec skips that one shot rather
 * than failing the run.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /manualShots\.spec\.ts/,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  // One serial test that walks nine screens and seeds a trip through its whole
  // lifecycle between them; the default 90s is nowhere near enough.
  timeout: 900_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    locale: "en-US",
    permissions: ["geolocation", "camera"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
