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

    // PRECONDITION: the LIVE value starts at spec. Under the cutoff there is
    // deliberately NO same-day live repair (a reset stages the correction for
    // tomorrow), so a dirty starting value must fail loudly here — not as a
    // confusing mid-test assertion.
    expect(
      await getTruckWeekdayRate(admin.accessToken, PLX),
      "PRECONDITION: PLX live weekday must start at spec — the DB is dirty (a staged correction folds at the next MYT midnight)"
    ).toBe(SPEC_WEEKDAY);

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
      // LIVE spec value, plus the staged-edit note with the DRIFTED value.
      const plxRow = page.locator("tr", { hasText: PLX });
      // Rates render 2-dp (formatMoney): the live weekday cell shows "RM 11.00".
      await expect(plxRow.getByText(`RM ${SPEC_WEEKDAY}.00`, { exact: true })).toBeVisible();
      await expect(plxRow.getByText(new RegExp(`New rates weekday RM ${DRIFT_WEEKDAY}.*take effect .*\\(MYT\\)`))).toBeVisible();

      // Reset → confirm dialog (which spells out the next-day rule) → Reset.
      await page.getByRole("button", { name: /Reset to UWC spec defaults/ }).click();
      await expect(page.getByText("Reset truck rates to UWC spec?")).toBeVisible();
      await page.getByRole("button", { name: "Reset", exact: true }).click();

      // WAIT ON THINGS THAT ONLY EXIST AFTER THE MUTATION RESOLVES. The live
      // table value never changes under the cutoff and /reset/i matches the
      // reset BUTTON label, so neither is a real wait — asserting the pending
      // API value straight after click() raced the in-flight POST (the 3 Jul
      // prod failure: pending read 12 before the reset landed).
      //   1. the result banner ("… already at spec …") renders on success;
      await expect(page.getByText(/already at spec/)).toBeVisible();
      //   2. the PLX staged note now shows the SPEC value (refetch completed);
      await expect(plxRow.getByText(new RegExp(`New rates weekday RM ${SPEC_WEEKDAY}`))).toBeVisible();
      //   3. and the API agrees (poll — tolerate refetch/API ordering).
      await expect
        .poll(() => getTruckPendingWeekdayRate(admin.accessToken, PLX))
        .toBe(SPEC_WEEKDAY);
      // Live value STILL never moved — the whole point of the cutoff.
      expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
    } finally {
      // Belt-and-suspenders: stage everything back to spec even if the UI step
      // failed midway. The live value was never off spec; the staged spec
      // values fold in (as a no-op) at the next maturation sweep.
      await resetTruckRatesToSpec(admin.accessToken);
      expect(await getTruckWeekdayRate(admin.accessToken, PLX)).toBe(SPEC_WEEKDAY);
      await expect
        .poll(async () => {
          const pending = await getTruckPendingWeekdayRate(admin.accessToken, PLX);
          return pending === null || pending === SPEC_WEEKDAY;
        })
        .toBe(true);
    }
  });
});
