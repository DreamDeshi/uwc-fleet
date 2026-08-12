import {
  AFTERNOON_CUTOFF_MIN,
  MORNING_CUTOFF_MIN,
  PICKUP_HOURS,
  PICKUP_MAX_DAY_OFFSET,
  PICKUP_MINUTES,
  PICKUP_MINUTE_STEP,
  PICKUP_WINDOW_START_HOUR,
  SESSION_SPLIT_MIN,
  type PickupSlot,
} from "./bookingEdit";

/**
 * The arithmetic behind the requestor's pickup calendar + clock dial.
 *
 * Everything here is pure and date-local (the form builds `pickupDate` from the
 * device clock, so the picker has to agree with it). THREE rules decide what is
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
 *
 *  3. B7'S CUT-OFFS — 08:30 for a morning pickup, 13:30 for an afternoon one,
 *     TODAY ONLY, and never for a return leg. The server refuses a booking made
 *     after them; this is what stops the app OFFERING one first.
 *
 * Keeping (3) separate from (2) matters for the same reason: it closes a whole
 * session at once rather than trimming the current hour, and it does not touch
 * a future date.
 */

/**
 * Who is choosing, for B7's purposes.
 *
 *  - `isReturn` — HIS exemption ("anytime before 12am"), so the cut-off does
 *    not apply at all;
 *  - `isAdmin`  — the OVERRIDE (owner ruling, 12 Aug 2026). The slot is
 *    offered, the server still demands a stated reason, and the reason is
 *    audited. Not an exemption.
 *
 * Both default to false — restricted — so a caller that forgets shows fewer
 * slots than the server would take rather than more.
 */
export interface CutoffOpts {
  isReturn?: boolean;
  isAdmin?: boolean;
}

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

/**
 * Would B7 refuse this slot for a REQUESTOR? — i.e. does an admin choosing it
 * need to state an override reason? Pure, and the ONE predicate the form asks,
 * so the reason box and the server's demand can never disagree.
 */
export function slotNeedsCutoffOverride(
  slot: PickupSlot,
  now: Date,
  opts: { isReturn?: boolean } = {}
): boolean {
  if (dayOffsetOf(dateForOffset(now, slot.dayOffset), now) !== 0) return false;
  return sessionIsClosed(slot.hour, now, opts.isReturn === true);
}

/** The last date the calendar will let you reach. */
export function maxBookableDate(now: Date): Date {
  return dateForOffset(now, PICKUP_MAX_DAY_OFFSET);
}

/**
 * B7's third rule: TODAY'S SESSIONS CLOSE (08:30 morning, 13:30 afternoon).
 *
 * Deliberately expressed the same way as rules (1) and (2) above — it applies
 * to TODAY ONLY, so a future date's dial is unaffected and stays stable.
 *
 * `isReturn` defaults to FALSE, i.e. restricted, on purpose. A caller that
 * forgets to say "this is a return" over-restricts, which shows the requestor
 * fewer slots than the server would take; the opposite default would OFFER a
 * slot the server refuses, which is the failure this whole change exists to
 * prevent. Wrong in the harmless direction, by construction.
 */
function sessionIsClosed(hour: number, now: Date, isReturn: boolean, isAdmin = false): boolean {
  if (isReturn) return false; // "anytime before 12am" — his own exemption
  // ⚠ AN ADMIN IS NOT EXEMPT — they may OVERRIDE, which is a different thing.
  // The picker offers them the slot; the server still refuses it unless they
  // state a reason, and that reason is audited. Hiding the slot from the office
  // would remove roughly ten hours of same-day capacity a day (the working day
  // runs to midnight) and urgent same-day work exists.
  if (isAdmin) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const cutoff = hour * 60 < SESSION_SPLIT_MIN ? MORNING_CUTOFF_MIN : AFTERNOON_CUTOFF_MIN;
  return nowMinutes >= cutoff;
}

/**
 * The minutes offered for one hour on one date. A full ring for any future
 * hour; on the CURRENT hour it is trimmed to what is still ahead, which is why
 * the ring can be partially — or entirely — empty. On TODAY it is also empty
 * once B7's cut-off for that hour's session has passed.
 */
export function bookableMinutes(
  date: Date,
  hour: number,
  now: Date,
  opts: CutoffOpts = {}
): number[] {
  if (!PICKUP_HOURS.includes(hour)) return [];
  const offset = dayOffsetOf(date, now);
  if (offset < 0 || offset > PICKUP_MAX_DAY_OFFSET) return [];
  if (offset > 0) return [...PICKUP_MINUTES];
  if (sessionIsClosed(hour, now, opts.isReturn === true, opts.isAdmin === true)) return [];
  if (hour > now.getHours()) return [...PICKUP_MINUTES];
  if (hour < now.getHours()) return [];
  return PICKUP_MINUTES.filter((m) => m > now.getMinutes());
}

/** The hours offered on one date — the window, minus anything already gone,
 *  minus any session B7 has closed for today. */
export function bookableHours(date: Date, now: Date, opts: CutoffOpts = {}): number[] {
  return CHRONOLOGICAL_HOURS.filter((h) => bookableMinutes(date, h, now, opts).length > 0);
}

/** Is this calendar date reachable at all? False once its last slot has passed. */
export function isDayBookable(date: Date, now: Date, opts: CutoffOpts = {}): boolean {
  const offset = dayOffsetOf(date, now);
  if (offset < 0 || offset > PICKUP_MAX_DAY_OFFSET) return false;
  if (offset > 0) return true; // the whole window is ahead
  // Today disappears from the calendar once BOTH sessions are shut — which is
  // what B7 means by "they have to choose next working day", expressed as an
  // absence rather than as an error after the fact.
  return bookableHours(date, now, opts).length > 0;
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
export function nextBookableSlot(
  now: Date = new Date(),
  leadMinutes = 60,
  opts: CutoffOpts = {}
): PickupSlot {
  const earliest = new Date(now.getTime() + leadMinutes * 60_000);
  for (let dayOffset = 0; dayOffset <= PICKUP_MAX_DAY_OFFSET; dayOffset++) {
    const date = dateForOffset(now, dayOffset);
    for (const hour of CHRONOLOGICAL_HOURS) {
      // Candidates come from bookableMinutes, NOT the raw ring, so the default
      // can never be a slot the dial then renders as disabled — the two rules
      // would otherwise disagree on the current minute (offered vs. past).
      for (const minute of bookableMinutes(date, hour, now, opts)) {
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
export function clampSlotToDay(
  slot: PickupSlot,
  now: Date,
  opts: CutoffOpts = {}
): PickupSlot {
  const date = dateForOffset(now, slot.dayOffset);
  const minutes = bookableMinutes(date, slot.hour, now, opts);
  if (minutes.includes(slot.minute)) return slot;
  if (minutes.length > 0) return { ...slot, minute: minutes[0] };
  const hours = bookableHours(date, now, opts);
  if (hours.length > 0) {
    const hour = hours.find((h) => h >= slot.hour) ?? hours[0];
    return { ...slot, hour, minute: bookableMinutes(date, hour, now, opts)[0] ?? 0 };
  }
  // Both of today's sessions are shut: fall forward to the first open slot,
  // which is the next day the picker offers. THIS is the line that keeps a
  // requestor who switches route type or date from sitting on a slot the
  // server would refuse.
  return nextBookableSlot(now, 60, opts);
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
