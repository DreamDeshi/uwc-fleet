import { getSettingValue } from "./settingsRegistry";

/**
 * Phase 3 — the operating-window estimate's tuning knobs, and the
 * scheduling-conflict buffer, resolved through the DB→env→default order like
 * every other setting in settingsRegistry.ts. Both `operatingWindow.ts` and
 * `schedulingConflict.ts` stay PURE (no DB, no clock); this is the one
 * non-pure seam, used only by the route/dispatch layers.
 */
export async function effectiveOperatingEstimateDefaults(): Promise<{
  loadMin: number;
  unloadMinPerStop: number;
  driveMinPerLeg: number;
  drivePointsBaseline: number;
}> {
  const [loadMin, unloadMinPerStop, driveMinPerLeg, drivePointsBaseline] = await Promise.all([
    getSettingValue<number>("dispatch.op_load_min"),
    getSettingValue<number>("dispatch.op_unload_min_per_stop"),
    getSettingValue<number>("dispatch.op_drive_min_per_leg"),
    getSettingValue<number>("dispatch.op_drive_points_baseline"),
  ]);
  return { loadMin, unloadMinPerStop, driveMinPerLeg, drivePointsBaseline };
}

export async function effectiveAssignmentConflictBufferMs(): Promise<number> {
  const bufferMin = await getSettingValue<number>("dispatch.assignment_conflict_buffer_min");
  return bufferMin * 60 * 1000;
}
