/**
 * Malaysia-time (MYT, fixed UTC+8, no DST) calendar helpers for aggregation
 * and reporting — hoisted from the identical copies that lived in users.ts and
 * trucks.ts, so month/day bucketing never depends on the server's TZ env.
 * (The incentive engine keeps its own self-contained MYT math: it is pure and
 * imports nothing from here by design.)
 */
export const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The MYT wall-clock { year, month(0-11) } containing the instant. */
export function mytMonthParts(d: Date): { year: number; month: number } {
  const myt = new Date(d.getTime() + MYT_OFFSET_MS);
  return { year: myt.getUTCFullYear(), month: myt.getUTCMonth() };
}

/**
 * UTC instant of the MYT month start for (year, monthIndex). monthIndex may be
 * out of 0-11 (e.g. month - 5); Date.UTC normalises it across year boundaries.
 */
export function mytMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1) - MYT_OFFSET_MS);
}

/** [start, end) UTC instants bounding the current MYT calendar month. */
export function currentMytMonthBounds(now: Date): { start: Date; end: Date } {
  const { year, month } = mytMonthParts(now);
  return { start: mytMonthStart(year, month), end: mytMonthStart(year, month + 1) };
}

/**
 * Whether an instant falls inside [start, end) month bounds. The ONE
 * "this month" predicate every money endpoint must share: a lower bound
 * alone lets a trip dated next month leak into the current month's figure
 * in one endpoint but not another, and the clerk sees two different totals
 * for the same driver (audit finding 1.3).
 */
export function inMytMonth(instant: Date, bounds: { start: Date; end: Date }): boolean {
  return instant >= bounds.start && instant < bounds.end;
}

/**
 * [start, end) UTC instants for a "YYYY-MM" MYT month key (the payroll month
 * selector's wire format). Returns null for anything that isn't a plausible
 * key, so routes can 400 instead of silently binning a typo into NaN-land.
 */
export function mytMonthBoundsForKey(key: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { start: mytMonthStart(year, month - 1), end: mytMonthStart(year, month) };
}

/** "YYYY-MM" of the MYT month containing the instant. */
export function mytMonthKey(d: Date): string {
  const { year, month } = mytMonthParts(d);
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * [start, end) UTC instants for a "YYYY-MM-DD" MYT calendar day (the trip
 * board's date-filter wire format). Returns null for anything that isn't a
 * plausible key, so routes can ignore a malformed filter instead of silently
 * cutting on the wrong boundary. Without this, `new Date("2026-07-05")` is
 * UTC midnight = 08:00 MYT — a "From 5 Jul" filter dropped every trip picked
 * up 00:00–07:59 MYT that day (audit 2026-07-05 #3, the input-side twin of
 * the MYT display fix).
 */
export function mytDayBoundsForKey(key: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = new Date(Date.UTC(year, month - 1, day) - MYT_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Serial index of the MYT calendar day containing the instant — for "same
 * MYT day or earlier" comparisons (the on-time rule).
 */
export function mytDayIndex(d: Date): number {
  return Math.floor((d.getTime() + MYT_OFFSET_MS) / DAY_MS);
}
