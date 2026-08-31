/**
 * Append-only incentive CORRECTION (R6-2/R6-3, owner ruling 29 Aug 2026 —
 * see AGENTS.md's "incentive-correction" note and
 * [[incentive-correction-is-impossible-today]] in the project memory).
 *
 * `Trip.incentive_final` is write-once: `approveTripIncentiveOnce`'s CAS
 * never matches a `completed` trip again, and payroll has no period lock —
 * an in-place correction would silently rewrite an ALREADY-PAID month, so
 * the same report run twice a month apart would return different numbers
 * with nothing explaining why.
 *
 * The fix is a NEW line landing in the CURRENT month, never an edit to the
 * original. Pure logic lives here so it is unit-testable without a DB; the
 * route (routes/trips.ts) does the Prisma read/write.
 */

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

/** Whole calendar-month distance from `fromKey` to `toKey` ("YYYY-MM" each),
 * or null if either is malformed. Calendar-month distance, not day count —
 * "3 months back" means the trip's month and the 3 before it, not a rolling
 * 90-day window. */
export function monthsBetweenKeys(fromKey: string, toKey: string): number | null {
  const mFrom = MONTH_KEY_RE.exec(fromKey);
  const mTo = MONTH_KEY_RE.exec(toKey);
  if (!mFrom || !mTo) return null;
  return (Number(mTo[1]) - Number(mFrom[1])) * 12 + (Number(mTo[2]) - Number(mFrom[2]));
}

/** R6-3: the cap, in whole months, on how far back a trip's own pay month
 * may sit before an adjustment against it is refused. */
export const INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK = 3;

/**
 * R6-3 gate: is `tripMonthKey` within the adjustable window as of
 * `nowMonthKey`? True for the current month itself (distance 0) through
 * exactly `INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK` months back. A trip dated
 * in the FUTURE relative to now (distance negative, which should never
 * happen but costs nothing to guard) is also refused — this is a
 * correction window, not a general validity check on `nowMonthKey`.
 */
export function isWithinAdjustmentWindow(tripMonthKey: string, nowMonthKey: string): boolean {
  const diff = monthsBetweenKeys(tripMonthKey, nowMonthKey);
  return diff !== null && diff >= 0 && diff <= INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK;
}
