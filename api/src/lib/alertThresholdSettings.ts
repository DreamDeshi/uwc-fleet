import { getSettingValue } from "./settingsRegistry";

/**
 * Admin-settings Phase 4 — alert thresholds. Resolved through the DB→env→
 * default order like every other setting in settingsRegistry.ts. Kept in a
 * separate file (not imported by exceptionAlerts.ts/pendingTripAlerts.ts/
 * docExpiryReminders.ts's own constants) so those stay free of a circular
 * import: settingsRegistry.ts imports the DEFAULT constants FROM those files,
 * so those files cannot import FROM settingsRegistry.ts in turn. Same shape
 * as bookingCutoffSettings.ts / dispatchWindowSettings.ts / dispatchTuningSettings.ts.
 */

export async function effectiveExceptionAlertThresholdMin(): Promise<number> {
  return getSettingValue<number>("alert.exception_threshold_min");
}

export async function effectivePendingTripAlertThresholds(): Promise<{
  pendingTripThresholdMin: number;
  pendingRetryCeilingMin: number;
}> {
  const [pendingTripThresholdMin, pendingRetryCeilingMin] = await Promise.all([
    getSettingValue<number>("alert.pending_trip_threshold_min"),
    getSettingValue<number>("alert.pending_retry_ceiling_min"),
  ]);
  return { pendingTripThresholdMin, pendingRetryCeilingMin };
}

export async function effectiveDocExpiryRemindDays(): Promise<number> {
  return getSettingValue<number>("alert.doc_expiry_remind_days");
}
