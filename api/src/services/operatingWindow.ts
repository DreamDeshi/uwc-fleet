/**
 * Operating-window cutoff (Phase 3 — AUTO DISPATCH LOGIC A36–A38).
 *
 * Estimates when a delivery run would FINISH and flags routes that spill past
 * the truck's operating window (default 07:00–18:00), or whose pickup itself is
 * outside the window. Pure (no DB, no Date.now()) so it is unit-testable; the
 * caller passes the pickup instant, the stop count, and the truck's window.
 *
 * Estimate (configurable via env, all minutes):
 *   estimated_completion = pickup
 *                        + OP_LOAD_MIN                       (load at the plant)
 *                        + stops × OP_DRIVE_MIN_PER_LEG      (legs base→s1→s2…→sN)
 *                        + stops × OP_UNLOAD_MIN_PER_STOP    (unload at each stop)
 *
 * Drive time is a FLAT per-leg figure. We have zone-centroid coordinates
 * (lib/geo.ts haversine) and Google Directions duration_s (when GOOGLE_MAPS_API_KEY
 * is set), but a flat per-leg estimate keeps this offline, deterministic and
 * free of an average-speed assumption.
 * // TODO refine with real distances later (per-leg zone-distance matrix or
 * //      Google duration_s) instead of a flat per-leg minute figure.
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

// The default operating window (matches Truck.operating_hours_* seed + spec §8).
export const DEFAULT_WINDOW_START = "07:00";
export const DEFAULT_WINDOW_END = "18:00";

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

/** The UTC instant of `windowEndMin` MYT on the SAME MYT day as `date`. */
function windowEndInstant(date: Date, windowEndMin: number): Date {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  // Date.UTC normalises an over-60 minutes field into the right hour/day.
  return new Date(
    Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate(), 0, windowEndMin) -
      MYT_OFFSET_MS
  );
}

export interface OperatingWindowInput {
  pickupDateTime: Date;
  stopCount: number; // number of delivery stops on the trip (≥1)
  windowStart?: string | null; // "HH:MM" MYT; defaults to 07:00
  windowEnd?: string | null; // "HH:MM" MYT; defaults to 18:00
  loadMin?: number;
  unloadMinPerStop?: number;
  driveMinPerLeg?: number;
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

  const windowStartMin = parseHmToMinutes(input.windowStart, parseHmToMinutes(DEFAULT_WINDOW_START, 7 * 60));
  const windowEndMin = parseHmToMinutes(input.windowEnd, parseHmToMinutes(DEFAULT_WINDOW_END, 18 * 60));

  // Legs base→stop1→…→stopN = N legs for N stops.
  const addedMinutes = loadMin + stops * driveMinPerLeg + stops * unloadMinPerStop;
  const estimatedCompletion = new Date(input.pickupDateTime.getTime() + addedMinutes * 60 * 1000);

  const pickupMinutesMyt = mytMinutesOfDay(input.pickupDateTime);
  const completionMinutesMyt = mytMinutesOfDay(estimatedCompletion);

  const pickupOutsideWindow = pickupMinutesMyt < windowStartMin || pickupMinutesMyt > windowEndMin;
  const completionPastWindow =
    estimatedCompletion.getTime() > windowEndInstant(input.pickupDateTime, windowEndMin).getTime();

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
