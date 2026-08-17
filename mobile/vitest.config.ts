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
 *
 * ⚠ WHAT THE PIN HIDES — its first known consequence, 18 Aug 2026.
 *
 * Under the pin, the DEVICE clock and the SERVER's MYT are the same clock, so
 * no test can tell "reads MYT" from "reads whatever the device says". Two home
 * screens read the device (`toDateString()`, a local Y/M/D compare) and every
 * suite was green; on the web build, a laptop on UTC, the driver's Home said
 * "no trips assigned today" about a day the dashboard called today.
 *
 * The pin did not cause it — it removed the only condition that would have
 * shown it. So a spec about WHICH CLOCK IS CONSULTED must use INSTANTS whose
 * MYT day differs from their UTC day (`2026-08-17T18:30:00Z` is the 18th in
 * MYT), never a wall-clock fixture, which is correct by assumption here. See
 * `src/lib/mytDay.test.ts`.
 */
export default defineConfig({
  /**
   * `react-native` itself is Flow-typed source that Vite cannot parse, so any
   * test importing a screen or component used to fail at collection — which is
   * why every spec here was a pure-logic one and no RENDER was ever asserted.
   *
   * Aliasing to `react-native-web` is exactly what the app does on web (this is
   * the same package Expo's web build resolves RN to), so a component rendered
   * under this alias is the real component, not a stand-in. It lets a spec ask
   * the question that matters for a gated surface: does this actually DRAW
   * anything? See `components/DemoRoleSwitcher.test.tsx`, which renders the
   * login screen with the demo flag off and asserts the markup is bare.
   */
  resolve: { alias: { "react-native": "react-native-web" } },
  test: {
    env: { TZ: "Asia/Kuala_Lumpur" },
  },
});
