import {
  PICKUP_HOURS,
  PICKUP_MAX_DAY_OFFSET,
  PICKUP_MINUTES,
  PICKUP_MINUTE_STEP,
  PICKUP_WINDOW_START_HOUR,
  type PickupSlot,
} from "./bookingEdit";

/**
 * The arithmetic behind the requestor's pickup calendar + clock dial.
 *
 * Everything here is pure and date-local (the form builds `pickupDate` from the
 * device clock, so the picker has to agree with it). Two rules decide what is
 * offered, and they are separate on purpose:
 *
 *  1. THE FLEET WINDOW — 07:00 → 02:00, wrapping midnight. Fixed, the same on
 *     every date, mirrored from the server (see bookingEdit's header). This is
 *     what dims 03:00–06:00 on the dial.
 *  2. THE PAST — a slot already gone today is not offered. This is what makes
 *     "today" shrink through the day and eventually disappear from the
 *     calendar entirely.
 *
 * Keeping them separate matters: a date in the future is governed by (1) alone,
 * so the dial's disabled ring is stable rather than mysteriously changing when
 * you pick a different day.
 */

/** Hours in CHRONOLOGICAL order (00…02, 07…23) rather than shift order. */
const CHRONOLOGICAL_HOURS: readonly number[] = [...PICKUP_HOURS].sort((a, b) => a - b);

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Whole days from `now`'s calendar date to `date`'s. Round, not floor — a DST
 *  jump on a device outside Malaysia makes the span ±1h off a whole day. */
export function dayOffsetOf(date: Date, now: Date): number {
  return Math.round((+startOfDay(date) - +startOfDay(now)) / 86_400_000);
}

export function dateForOffset(now: Date, dayOffset: number): Date {
  const d = startOfDay(now);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

/** The slot as a real instant, on the requestor's own clock. */
export function slotToDate(now: Date, slot: PickupSlot): Date {
  const d = dateForOffset(now, slot.dayOffset);
  d.setHours(slot.hour, slot.minute, 0, 0);
  return d;
}

/** The last date the calendar will let you reach. */
export function maxBookableDate(now: Date): Date {
  return dateForOffset(now, PICKUP_MAX_DAY_OFFSET);
}

/**
 * The minutes offered for one hour on one date. A full ring for any future
 * hour; on the CURRENT hour it is trimmed to what is still ahead, which is why
 * the ring can be partially — or entirely — empty.
 */
export function bookableMinutes(date: Date, hour: number, now: Date): number[] {
  if (!PICKUP_HOURS.includes(hour)) return [];
  const offset = dayOffsetOf(date, now);
  if (offset < 0 || offset > PICKUP_MAX_DAY_OFFSET) return [];
  if (offset > 0) return [...PICKUP_MINUTES];
  if (hour > now.getHours()) return [...PICKUP_MINUTES];
  if (hour < now.getHours()) return [];
  return PICKUP_MINUTES.filter((m) => m > now.getMinutes());
}

/** The hours offered on one date — the window, minus anything already gone. */
export function bookableHours(date: Date, now: Date): number[] {
  return CHRONOLOGICAL_HOURS.filter((h) => bookableMinutes(date, h, now).length > 0);
}

/** Is this calendar date reachable at all? False once its last slot has passed. */
export function isDayBookable(date: Date, now: Date): boolean {
  const offset = dayOffsetOf(date, now);
  if (offset < 0 || offset > PICKUP_MAX_DAY_OFFSET) return false;
  if (offset > 0) return true; // the whole window is ahead
  return bookableHours(date, now).length > 0;
}

/**
 * The form's default pickup: the first slot at least `leadMinutes` away.
 *
 * The lead exists because the picker is now minute-accurate. Without it, at
 * 14:31 the form would pre-fill 14:35 — four minutes out, a pickup nobody can
 * meet — where the hour-only form used to land on 15:00. An hour of lead keeps
 * that behaviour while letting the requestor deliberately choose something
 * sooner from the dial.
 *
 * Scans forward day by day, so it crosses the fleet's closed 03:00–06:00 gap
 * and midnight without either being special-cased.
 */
export function nextBookableSlot(now: Date = new Date(), leadMinutes = 60): PickupSlot {
  const earliest = new Date(now.getTime() + leadMinutes * 60_000);
  for (let dayOffset = 0; dayOffset <= PICKUP_MAX_DAY_OFFSET; dayOffset++) {
    const date = dateForOffset(now, dayOffset);
    for (const hour of CHRONOLOGICAL_HOURS) {
      // Candidates come from bookableMinutes, NOT the raw ring, so the default
      // can never be a slot the dial then renders as disabled — the two rules
      // would otherwise disagree on the current minute (offered vs. past).
      for (const minute of bookableMinutes(date, hour, now)) {
        const candidate = new Date(date);
        candidate.setHours(hour, minute, 0, 0);
        if (candidate >= earliest) return { dayOffset, hour, minute };
      }
    }
  }
  // Unreachable while the window has any open hour — a year of days is scanned
  // above — but a total is better than a crash if the window is ever emptied.
  return { dayOffset: 0, hour: PICKUP_WINDOW_START_HOUR, minute: 0 };
}

/**
 * Nudge a slot back onto a bookable moment after the DATE changed.
 *
 * Moving from "tomorrow 08:00" to "today" at 14:00 would otherwise leave a
 * pickup six hours in the past, which the server rejects only at submit. Keeps
 * the requestor's chosen time when it survives the move.
 */
export function clampSlotToDay(slot: PickupSlot, now: Date): PickupSlot {
  const date = dateForOffset(now, slot.dayOffset);
  const minutes = bookableMinutes(date, slot.hour, now);
  if (minutes.includes(slot.minute)) return slot;
  if (minutes.length > 0) return { ...slot, minute: minutes[0] };
  const hours = bookableHours(date, now);
  if (hours.length > 0) {
    const hour = hours.find((h) => h >= slot.hour) ?? hours[0];
    return { ...slot, hour, minute: bookableMinutes(date, hour, now)[0] ?? 0 };
  }
  return nextBookableSlot(now);
}

// ── Month grid ────────────────────────────────────────────────────────────

export interface CalendarCell {
  /** null = a leading/trailing blank that keeps the weekday columns aligned. */
  date: Date | null;
}

/**
 * A Monday-first month grid, padded with blanks so column 0 is always Monday.
 * Returns a flat list; the view chunks it into rows of seven.
 */
export function monthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  // getDay() is Sunday-first (0=Sun); shift so Monday is 0.
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ date: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(year, month, d) });
  return cells;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Can the calendar step to this month at all, given today and the year cap? */
export function isMonthReachable(year: number, month: number, now: Date): boolean {
  const monthEnd = new Date(year, month + 1, 0);
  const monthStart = new Date(year, month, 1);
  return monthEnd >= startOfDay(now) && monthStart <= maxBookableDate(now);
}

// ── Dial geometry ─────────────────────────────────────────────────────────

/**
 * Where a number sits on the clock face. 12 o'clock is straight up and the ring
 * runs clockwise, so index 0 of a 12-position ring is at the top. Returned as a
 * top-left offset for a `size`-wide marker inside a `diameter` circle, which is
 * what an absolutely-positioned RN View wants.
 */
export function dialPosition(
  index: number,
  total: number,
  diameter: number,
  markerSize: number,
  inset: number
): { left: number; top: number } {
  const radius = diameter / 2 - inset - markerSize / 2;
  const angle = (index / total) * 2 * Math.PI - Math.PI / 2;
  const centre = diameter / 2 - markerSize / 2;
  return {
    left: centre + radius * Math.cos(angle),
    top: centre + radius * Math.sin(angle),
  };
}

/** The hand's rotation, in degrees, for position `index` of a `total` ring. */
export function dialAngle(index: number, total: number): number {
  return (index / total) * 360;
}

/** 24h hour → the 12-hour dial's position (12 sits at index 0, i.e. the top). */
export function hourDialIndex(hour24: number): number {
  return hour24 % 12;
}

/** Dial position + meridiem → the 24h hour it means. */
export function dialIndexToHour(index: number, meridiem: "AM" | "PM"): number {
  const base = index % 12;
  return meridiem === "PM" ? (base === 0 ? 12 : base + 12) : base;
}

export function meridiemOf(hour24: number): "AM" | "PM" {
  return hour24 >= 12 ? "PM" : "AM";
}

/** The 12 hour labels of a ring, in dial order: 12, 1, 2 … 11. */
export const HOUR_RING: readonly number[] = Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i));

/** The 12 minute labels of a ring, in dial order: 00, 05 … 55. */
export const MINUTE_RING: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => i * PICKUP_MINUTE_STEP
);
