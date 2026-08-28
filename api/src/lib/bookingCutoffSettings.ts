import { getSettingValue } from "./settingsRegistry";

/**
 * The effective B7 cut-off minutes right now — DB override if an admin has
 * set one, else the defaults `bookingCutoff.ts` has always used. Deliberately
 * separate from `bookingCutoff.ts`: that module is PURE (no DB, no clock —
 * see its own header), and stays that way. This is the one non-pure seam,
 * used only by the route layer, which already touches Prisma.
 */
export async function effectiveBookingCutoffs(): Promise<{
  morningCutoffMin: number;
  afternoonCutoffMin: number;
  sessionSplitMin: number;
}> {
  const [morningCutoffMin, afternoonCutoffMin, sessionSplitMin] = await Promise.all([
    getSettingValue<number>("booking.morning_cutoff_min"),
    getSettingValue<number>("booking.afternoon_cutoff_min"),
    getSettingValue<number>("booking.session_split_min"),
  ]);
  return { morningCutoffMin, afternoonCutoffMin, sessionSplitMin };
}
