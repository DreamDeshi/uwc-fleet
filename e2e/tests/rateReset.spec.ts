import { test, expect } from "@playwright/test";
import { ADMIN } from "../helpers/accounts";
import {
  getTruckWeekdayRate,
  login,
  patchTruckRates,
  resetTruckRatesToSpec,
} from "../helpers/api";
import { adminLogin } from "../helpers/ui";

/**
 * RESET RATES TO SPEC DEFAULT (admin rate editor).
 *
 * The pure planner is unit-tested in api/tests/rateReset.test.ts; this drives
 * the full admin UI flow: an admin drifts a rate, clicks "Reset to UWC spec
 * defaults", confirms, and the table returns to the authoritative spec value.
 *
 * PLX 2406's spec weekday rate is 11 (docs/uwc-spec.json). The test drifts it to
 * 12, then resets — leaving the live DB back at spec regardless of outcome.
 */
const PLX = "PLX 2406";
const SPEC_WEEKDAY = 11; // docs/uwc-spec.json
const DRIFT_WEEKDAY = 12;

test.describe("Reset truck rates to UWC spec defaults", () => {
  test("admin drifts a rate, resets via the UI, table returns to spec", async ({ page }) => {
    const admin = await login(ADMIN);

    // Introduce drift directly (API setup, the suite's pattern): PLX weekday → 12.
    await patchTruckRates(admin.accessToken, PLX, { entitled_claim_weekday: DRIFT_WEEKDAY });
    expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(DRIFT_WEEKDAY);

    try {
      await adminLogin(page, ADMIN);
      await page.getByRole("link", { name: "Incentive Rates" }).click();
      await expect(page).toHaveURL(/\/incentives$/);

      // "Truck Claim Rates" is the default tab. The PLX row shows the drifted
      // value before the reset.
      const plxRow = page.locator("tr", { hasText: PLX });
      await expect(plxRow.getByText(`RM ${DRIFT_WEEKDAY}`, { exact: true })).toBeVisible();

      // Reset → confirm dialog → Reset.
      await page.getByRole("button", { name: /Reset to UWC spec defaults/ }).click();
      await expect(page.getByText("Reset truck rates to UWC spec?")).toBeVisible();
      await page.getByRole("button", { name: "Reset", exact: true }).click();

      // Result banner + the table now shows the spec value again.
      await expect(page.getByText(/reset/i).first()).toBeVisible();
      await expect(plxRow.getByText(`RM ${SPEC_WEEKDAY}`, { exact: true })).toBeVisible();
    } finally {
      // Belt-and-suspenders: ensure the live DB is back at spec even if the UI
      // step failed midway (the reset endpoint restores ALL trucks).
      await resetTruckRatesToSpec(admin.accessToken);
      expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
    }
  });
});
