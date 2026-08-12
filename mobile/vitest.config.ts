import { defineConfig } from "vitest/config";

/**
 * ⚠ THE SUITE RUNS IN MALAYSIA TIME, DELIBERATELY.
 *
 * Most of this app's date arithmetic is LOCAL on purpose — the pickup picker's
 * fleet window and its past-trim are about the wall clock in front of the
 * requestor — so a large number of specs use local wall-clock fixtures like
 * `new Date(2026, 6, 15, 10, 30)`. Those are only meaningful if "local" is a
 * known quantity.
 *
 * It was not. The developer machine is UTC+8, CI runners are UTC, and B7's
 * booking cut-off is judged in MYT: on 12 Aug 2026 that combination produced a
 * suite that passed locally and failed in CI for six specs, because "10:30
 * local" meant 10:30 MYT on one machine and 18:30 MYT on the other.
 *
 * Pinning the zone makes those fixtures mean the same thing everywhere. It does
 * NOT paper over the MYT logic itself: `cutoffClosedAt` is exercised by specs
 * that take two INSTANTS and are therefore timezone-independent by
 * construction — those are what actually prove the conversion, and they would
 * still fail here if it broke.
 */
export default defineConfig({
  test: {
    env: { TZ: "Asia/Kuala_Lumpur" },
  },
});
