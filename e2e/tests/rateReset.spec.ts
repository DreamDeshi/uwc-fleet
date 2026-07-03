import { test, expect } from "@playwright/test";
import { ADMIN } from "../helpers/accounts";
import {
  getTruckPendingWeekdayRate,
  getTruckWeekdayRate,
  login,
  patchTruckRates,
  resetTruckRatesToSpec,
} from "../helpers/api";
import { adminLogin } from "../helpers/ui";

/**
 * RESET RATES TO SPEC DEFAULT (admin rate editor) under the NEXT-MYT-DAY
 * CUTOFF (client rule, 3 Jul 2026): a rate edit no longer changes the live
 * value same-day — it is STAGED with an effective date of tomorrow, the table
 * keeps showing the live rate plus a "takes effect" note, and today's
 * assignments still snapshot today's rates.
 *
 * The pure planner + cutoff merge are unit-tested (api/tests/rateReset.test.ts,
 * api/tests/pendingRates.test.ts); this drives the full admin UI flow: an
 * admin drifts a rate (staged), clicks "Reset to UWC spec defaults", confirms,
 * and the staged values return to spec while the live value never moved.
 *
 * PLX 2406's spec weekday rate is 11 (docs/uwc-spec.json). The test stages a
 * drift to 12, then resets — leaving the DB consistent regardless of outcome.
 */
const PLX = "PLX 2406";
const SPEC_WEEKDAY = 11; // docs/uwc-spec.json
const DRIFT_WEEKDAY = 12;

test.describe("Reset truck rates to UWC spec defaults (next-day cutoff)", () => {
  test("admin stages a drift, resets via the UI, staged rates return to spec; live rate never moves", async ({ page }) => {
    const admin = await login(ADMIN);

    // Introduce drift directly (API setup, the suite's pattern): PLX weekday →
    // 12. Under the cutoff this is STAGED for tomorrow — the LIVE value stays
    // at spec, which is exactly the client's "not immediately" rule.
    await patchTruckRates(admin.accessToken, PLX, { entitled_claim_weekday: DRIFT_WEEKDAY });
    expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
    expect(await getTruckPendingWeekdayRate(admin.accessToken, PLX)).toBe(DRIFT_WEEKDAY);

    try {
      await adminLogin(page, ADMIN);
      await page.getByRole("link", { name: "Incentive Rates" }).click();
      await expect(page).toHaveURL(/\/incentives$/);

      // "Truck Claim Rates" is the default tab. The PLX row still shows the
      // LIVE spec value, plus the staged-edit note with its effective date.
      const plxRow = page.locator("tr", { hasText: PLX });
      await expect(plxRow.getByText(`RM ${SPEC_WEEKDAY}`, { exact: true })).toBeVisible();
      await expect(plxRow.getByText(/New rates .*take effect .*\(MYT\)/)).toBeVisible();

      // Reset → confirm dialog (which spells out the next-day rule) → Reset.
      await page.getByRole("button", { name: /Reset to UWC spec defaults/ }).click();
      await expect(page.getByText("Reset truck rates to UWC spec?")).toBeVisible();
      await expect(page.getByText(/take effect/i).first()).toBeVisible();
      await page.getByRole("button", { name: "Reset", exact: true }).click();

      // Result banner appears; the staged drift is replaced by spec values.
      await expect(page.getByText(/reset/i).first()).toBeVisible();
      await expect(plxRow.getByText(`RM ${SPEC_WEEKDAY}`, { exact: true })).toBeVisible();
      expect(await getTruckPendingWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
    } finally {
      // Belt-and-suspenders: stage everything back to spec even if the UI step
      // failed midway. The live value was never off spec; the staged spec
      // values fold in (as a no-op) at the next maturation sweep.
      await resetTruckRatesToSpec(admin.accessToken);
      expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
      const pending = await getTruckPendingWeekdayRate(admin.accessToken, PLX);
      expect(pending === null || pending === SPEC_WEEKDAY).toBe(true);
    }
  });
});
