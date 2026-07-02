/**
 * Driver leave — date-based dispatch availability (tracker #4).
 *
 * Leave feeds DISPATCH, never pay: a driver whose leave covers a trip's pickup
 * MYT date is excluded from auto-dispatch candidates and blocked in the manual
 * approve, while staying available for trips on other dates (a driver on leave
 * 2026-03-20 can still take a booking picked up 2026-03-19). Their login is
 * untouched — leave is availability, NOT the account-disable status.
 *
 * Dates are inclusive "YYYY-MM-DD" MYT strings (same convention as the
 * PublicHoliday calendar), so plain string comparison IS date comparison.
 * The pure pieces here are unit-tested (tests/driverLeave.test.ts); the
 * Prisma where-fragment is built from the same helper so the SQL filter and
 * the in-code rule can never diverge.
 */

export interface LeaveRange {
  start_date: string; // inclusive
  end_date: string; // inclusive
}

/** True when `dateKey` (MYT "YYYY-MM-DD") falls inside the leave range. */
export function leaveCoversDate(leave: LeaveRange, dateKey: string): boolean {
  return leave.start_date <= dateKey && leave.end_date >= dateKey;
}

/**
 * Prisma where-fragment matching leave rows that cover `dateKey` — the query
 * form of leaveCoversDate. Used inside the auto-dispatch candidate filter
 * (`driver.is.leaves.none`) and the manual approve guard (`findFirst`).
 */
export function leaveDateFilter(dateKey: string): {
  start_date: { lte: string };
  end_date: { gte: string };
} {
  return { start_date: { lte: dateKey }, end_date: { gte: dateKey } };
}
