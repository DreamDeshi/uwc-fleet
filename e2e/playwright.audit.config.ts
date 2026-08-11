import { defineConfig, devices } from "@playwright/test";

/**
 * On-demand config for the visual UI audit sweep.
 *
 * Separate from `playwright.config.ts` because the sweep is a capture tool
 * rather than a check: it walks every screen for all three roles in en/ms/zh at
 * phone and desktop widths, writes ~90 PNGs plus `ui-audit-findings.json` under
 * `screenshots/ui-audit/`, and deliberately asserts NOTHING — a failing
 * assertion would stop it at the first bad screen, when the whole point is to
 * see all of them. The main config ignores it for that reason.
 *
 * It still needs a real backend (it logs in and switches language through the
 * API), so point it at a local stack:
 *
 *   npm run test:db:up
 *   SENSITIVE_RATE_LIMIT_MAX=0 RATE_LIMIT_MAX=0 LOGIN_LOCKOUT_MAX_ATTEMPTS=0 npm run test:db:api
 *   cd mobile && npx expo start --web --port 8081 --clear
 *   cd e2e && E2E_API_URL=http://localhost:3000 E2E_MOBILE_URL=http://localhost:8081 \
 *     npx playwright test --config playwright.audit.config.ts
 *
 * ⚠ Restart Metro with --clear before an AFTER capture, or you will screenshot
 * the previous bundle and conclude your fix did nothing.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /uiAuditSweep\.spec\.ts/,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    permissions: ["geolocation", "camera"],
    geolocation: { latitude: 5.34, longitude: 100.46 }, // Batu Kawan, Penang
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
