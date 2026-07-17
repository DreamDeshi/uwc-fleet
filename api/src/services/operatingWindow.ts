/**
 * Operating-window cutoff (Phase 3 — AUTO DISPATCH LOGIC A36–A38).
 *
 * Estimates when a delivery run would FINISH and flags routes that spill past
 * the truck's operating window (default 07:00–02:00), or whose pickup itself is
 * outside the window. Pure (no DB, no Date.now()) so it is unit-testable; the
 * caller passes the pickup instant, the stop count, and the truck's window.
 *
 * WRAPPING WINDOWS: since item 12 (Mr. Teh, 17 Jul 2026 — "can pickup time
 * allow set until 2AM instead of 6pm") the default window ends at 02:00, i.e.
 * PAST midnight, so an operating day is 07:00 → 02:00 the next calendar day and
 * the interval is a union of two halves rather than a simple [start, end] scan.
 * A truck given a conventional same-day window (start < end) keeps exactly the
 * old behaviour — see windowWraps/isWithinWindow.
 *
 * The window bounds BOTH the pickup and the estimated completion, which is one
 * decision, not two: a pickup is valid inside the window, and the run must be
 * done before the same operating day closes. Widening the end to 02:00 grants
 * daytime runs far more slack than the old 18:00 (an evening long-haul now
 * auto-dispatches where it used to be held), and it means a pickup close to
 * 02:00 still trips completion_past_window — exactly as an 18:00 pickup did
 * under the old window. ⚠ OPEN QUESTION for Mr. Teh: is 02:00 the latest a
 * truck may LEAVE, or the time it must be BACK? This code assumes the latter
 * (one shift-shaped window); if he means the former, the completion bound needs
 * to become its own setting.
 *
 * Estimate (configurable via env, all minutes):
 *   estimated_completion = pickup
 *                        + OP_LOAD_MIN                       (load at the plant)
 *                        + Σ drive minutes per leg           (legs base→s1→s2…→sN)
 *                        + stops × OP_UNLOAD_MIN_PER_STOP    (unload at each stop)
 *
 * Per-leg drive minutes SCALE with the destination zone's incentive points —
 * the closest distance proxy the system already has (Juru = 1 pt ≈ 15 min,
 * Ipoh = 6 pts ≈ 90 min at the defaults): leg = OP_DRIVE_MIN_PER_LEG ×
 * (points / OP_DRIVE_POINTS_BASELINE). A stop whose points are unknown (or a
 * caller that doesn't pass stopPoints) falls back to the FLAT
 * OP_DRIVE_MIN_PER_LEG — the previous behaviour, unchanged. Still an ESTIMATE:
 * offline, deterministic, no external distance API.
 *
 * Time handling: all wall-clock comparisons are in Malaysia time (MYT, fixed
 * UTC+8, no daylight saving) — never server-local — matching incentiveEngine.ts.
 */

// Malaysia is UTC+8 year-round. Add this to a UTC instant, then read the UTC*
// fields to get the wall-clock MYT parts (same convention as incentiveEngine).
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// Reads a non-negative-integer minutes value from an env var, falling back to
// `fallback` if unset or invalid.
function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const OP_LOAD_MIN = minutesFromEnv("OP_LOAD_MIN", 30);
export const OP_UNLOAD_MIN_PER_STOP = minutesFromEnv("OP_UNLOAD_MIN_PER_STOP", 20);
export const OP_DRIVE_MIN_PER_LEG = minutesFromEnv("OP_DRIVE_MIN_PER_LEG", 45);
// Zone points that correspond to ONE flat OP_DRIVE_MIN_PER_LEG of driving —
// a 3-point zone (Kulim/Penang tier) keeps the historical 45-minute leg.
function baselineFromEnv(): number {
  const raw = process.env.OP_DRIVE_POINTS_BASELINE;
  if (raw === undefined || raw.trim() === "") return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
export const OP_DRIVE_POINTS_BASELINE = baselineFromEnv();

// The default operating window (matches Truck.operating_hours_* default + spec §8).
//
// The end moved 18:00 → 02:00 on 17 Jul 2026 (Mr. Teh, item 12: "can pickup
// time allow set until 2AM instead of 6pm"), which makes the window WRAP past
// midnight: the operating day runs 07:00 → 02:00 the NEXT calendar day.
export const DEFAULT_WINDOW_START = "07:00";
export const DEFAULT_WINDOW_END = "02:00";

/** Parse "HH:MM" → minutes-from-midnight. Returns `fallback` on malformed input. */
export function parseHmToMinutes(hm: string | null | undefined, fallback: number): number {
  if (!hm) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}

/** Format minutes-from-midnight → "HH:MM" (clamped to the day for display). */
export function formatMinutesToHm(minutes: number): string {
  const clamped = Math.max(0, Math.min(minutes, 24 * 60 - 1));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}`;
}

/** Wall-clock minutes-from-midnight (MYT) of a UTC instant. */
function mytMinutesOfDay(date: Date): number {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  return myt.getUTCHours() * 60 + myt.getUTCMinutes();
}

/**
 * Does this window wrap past midnight (e.g. 07:00 → 02:00)? Strictly `end <
 * start`; an end EQUAL to the start stays non-wrapping (a degenerate
 * zero-length window) rather than silently meaning "open 24h".
 */
export function windowWraps(windowStartMin: number, windowEndMin: number): boolean {
  return windowEndMin < windowStartMin;
}

/**
 * Is a MYT time-of-day inside [start, end]? For a wrapping window the interval
 * is the UNION of [start, 23:59] and [00:00, end] — the two halves of one
 * operating day either side of midnight.
 */
export function isWithinWindow(minutesMyt: number, windowStartMin: number, windowEndMin: number): boolean {
  return windowWraps(windowStartMin, windowEndMin)
    ? minutesMyt >= windowStartMin || minutesMyt <= windowEndMin
    : minutesMyt >= windowStartMin && minutesMyt <= windowEndMin;
}

/**
 * The UTC instant at which the operating day CONTAINING `date` closes.
 *
 * Non-wrapping window (07:00–18:00): the end is `windowEndMin` on `date`'s own
 * MYT day — the original behaviour, unchanged.
 *
 * Wrapping window (07:00–02:00): the operating day straddles midnight, so
 * WHICH day's 02:00 closes it depends on which half `date` falls in —
 *   • 07:00–23:59 (the evening half) → the shift started today and closes at
 *     02:00 TOMORROW.
 *   • 00:00–02:00 (the small-hours half) → this is the tail of the shift that
 *     started at 07:00 YESTERDAY, so it closes at 02:00 TODAY.
 * That is the answer to "a 2AM pickup belongs to which operating day?": the
 * previous calendar day's. A time in neither half is outside the window
 * entirely (the caller flags it); we close it on its own day so the estimate
 * stays finite rather than throwing.
 */
function windowEndInstant(date: Date, windowStartMin: number, windowEndMin: number): Date {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const minutesMyt = myt.getUTCHours() * 60 + myt.getUTCMinutes();
  const rollsToNextDay = windowWraps(windowStartMin, windowEndMin) && minutesMyt >= windowStartMin;
  // Date.UTC normalises an over-60 minutes field (and a +1 day) into the right
  // hour/day, including across month and year ends.
  return new Date(
    Date.UTC(
      myt.getUTCFullYear(),
      myt.getUTCMonth(),
      myt.getUTCDate() + (rollsToNextDay ? 1 : 0),
      0,
      windowEndMin
    ) - MYT_OFFSET_MS
  );
}

export interface OperatingWindowInput {
  pickupDateTime: Date;
  stopCount: number; // number of delivery stops on the trip (≥1)
  /**
   * Destination-zone points per stop, in stop order (distance proxy for the
   * per-leg drive scaling). null = unknown zone → that leg uses the flat
   * figure. Omitted entirely → every leg is flat (previous behaviour).
   */
  stopPoints?: (number | null)[];
  windowStart?: string | null; // "HH:MM" MYT; defaults to 07:00
  windowEnd?: string | null; // "HH:MM" MYT; defaults to 18:00
  loadMin?: number;
  unloadMinPerStop?: number;
  driveMinPerLeg?: number;
  drivePointsBaseline?: number;
}

export interface OperatingWindowEstimate {
  estimatedCompletion: Date; // absolute instant
  addedMinutes: number; // load + drive + unload, from pickup
  pickupMinutesMyt: number; // pickup time-of-day, MYT
  completionMinutesMyt: number; // completion time-of-day, MYT (for the HH:MM label)
  completionLabel: string; // "HH:MM" of estimatedCompletion in MYT
  windowStartMin: number;
  windowEndMin: number;
  pickupOutsideWindow: boolean;
  completionPastWindow: boolean;
  exceedsWindow: boolean; // pickupOutsideWindow || completionPastWindow
  reason: "ok" | "pickup_outside_window" | "completion_past_window";
}

/**
 * Estimate a run's completion and whether it breaches the operating window.
 *
 * `exceedsWindow` is true when EITHER the pickup is outside [start,end] OR the
 * estimated completion lands after the window end on the pickup's MYT day
 * (comparing absolute instants, so a run spilling past midnight is caught too).
 */
export function estimateOperatingWindow(input: OperatingWindowInput): OperatingWindowEstimate {
  const stops = Math.max(0, Math.floor(input.stopCount));
  const loadMin = input.loadMin ?? OP_LOAD_MIN;
  const unloadMinPerStop = input.unloadMinPerStop ?? OP_UNLOAD_MIN_PER_STOP;
  const driveMinPerLeg = input.driveMinPerLeg ?? OP_DRIVE_MIN_PER_LEG;
  const drivePointsBaseline = input.drivePointsBaseline ?? OP_DRIVE_POINTS_BASELINE;

  // Use the truck's own window when it has one; fall back to the fleet default
  // (07:00–18:00). The double parse means even a malformed DB string degrades
  // safely to the default instead of breaking the estimate.
  const windowStartMin = parseHmToMinutes(input.windowStart, parseHmToMinutes(DEFAULT_WINDOW_START, 7 * 60));
  const windowEndMin = parseHmToMinutes(input.windowEnd, parseHmToMinutes(DEFAULT_WINDOW_END, 18 * 60));

  // Legs base→stop1→…→stopN = N legs for N stops. Each leg's drive minutes
  // scale with its destination zone's points (distance proxy); unknown points
  // (or no stopPoints at all) fall back to the flat per-leg figure.
  const legDriveMin = (points: number | null | undefined): number =>
    points != null && points > 0
      ? Math.round(driveMinPerLeg * (points / drivePointsBaseline))
      : driveMinPerLeg;
  const driveMinutes =
    input.stopPoints && input.stopPoints.length > 0
      ? input.stopPoints.reduce<number>((sum, p) => sum + legDriveMin(p), 0)
      : stops * driveMinPerLeg;

  const addedMinutes = loadMin + driveMinutes + stops * unloadMinPerStop;
  const estimatedCompletion = new Date(input.pickupDateTime.getTime() + addedMinutes * 60 * 1000);

  const pickupMinutesMyt = mytMinutesOfDay(input.pickupDateTime);
  const completionMinutesMyt = mytMinutesOfDay(estimatedCompletion);

  // Two separate breach modes: a pickup already outside the window (e.g. booked
  // for 05:00, which is in neither half of a 07:00–02:00 day) fails
  // immediately, no estimating needed…
  const pickupOutsideWindow = !isWithinWindow(pickupMinutesMyt, windowStartMin, windowEndMin);
  // …and a valid pickup whose run wouldn't get the driver home before the
  // operating day closes. Comparing ABSOLUTE instants (not times-of-day) is
  // what makes this correct across midnight: a 23:00 pickup on a 07:00–02:00
  // window is measured against 02:00 TOMORROW, while a 01:00 pickup — the tail
  // of yesterday's shift — is measured against 02:00 TODAY, an hour away.
  const completionPastWindow =
    estimatedCompletion.getTime() >
    windowEndInstant(input.pickupDateTime, windowStartMin, windowEndMin).getTime();

  const reason: OperatingWindowEstimate["reason"] = pickupOutsideWindow
    ? "pickup_outside_window"
    : completionPastWindow
      ? "completion_past_window"
      : "ok";

  return {
    estimatedCompletion,
    addedMinutes,
    pickupMinutesMyt,
    completionMinutesMyt,
    completionLabel: formatMinutesToHm(completionMinutesMyt),
    windowStartMin,
    windowEndMin,
    pickupOutsideWindow,
    completionPastWindow,
    exceedsWindow: pickupOutsideWindow || completionPastWindow,
    reason,
  };
}
