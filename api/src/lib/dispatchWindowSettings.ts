import { getSettingValue } from "./settingsRegistry";

/**
 * The effective fallback operating window right now — DB override if an admin
 * has set one, else the defaults `services/operatingWindow.ts` has always
 * used. Same shape as bookingCutoffSettings.ts, and the same reason for being
 * a separate file: `operatingWindow.ts`'s estimator is PURE (no DB, no
 * clock), and stays that way. This is the one non-pure seam.
 *
 * ⚠ Narrow reach on purpose — see the registry entries' own comment
 * (settingsRegistry.ts, "dispatch.window_start"). Every real Truck carries its
 * own operating hours, which always win; this is consulted only where a truck
 * lookup can come back empty at the moment of estimating.
 */
export async function effectiveDispatchWindowDefaults(): Promise<{
  windowStart: string;
  windowEnd: string;
}> {
  const [windowStart, windowEnd] = await Promise.all([
    getSettingValue<string>("dispatch.window_start"),
    getSettingValue<string>("dispatch.window_end"),
  ]);
  return { windowStart, windowEnd };
}

/**
 * PURE — the merge that makes the setting reachable at all, pulled out of
 * dispatchEngine.ts so it is unit-testable on its own (that file's
 * `autoDispatchTrip` is DB orchestration, not something a pure test can call
 * directly). A truck's OWN hours always win; `defaults` is consulted only
 * when `truck` itself is missing (the candidate no longer matches a loaded
 * truck) — see the registry entries' comment for why that's rare by design.
 */
export function resolveTruckWindow(
  truck: { operating_hours_start?: string | null; operating_hours_end?: string | null } | undefined,
  defaults: { windowStart: string; windowEnd: string }
): { windowStart: string; windowEnd: string } {
  return {
    windowStart: truck?.operating_hours_start ?? defaults.windowStart,
    windowEnd: truck?.operating_hours_end ?? defaults.windowEnd,
  };
}
