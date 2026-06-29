/**
 * Incentive engine — Development Brief Section 3.
 *
 * All functions here are pure (no DB, no Date.now()) so they can be unit
 * tested directly. The trips route is responsible for fetching the data
 * these functions need and passing it in.
 *
 * Design decision: incentive_earned on a Trip stores the MARGINAL
 * (per-trip) incentive — i.e. how much THIS trip added to the driver's
 * running day total. It is the floored day-total-with-this-trip minus the
 * floored day-total-before-this-trip. Storing the marginal means the
 * callers that SUM incentive_earned across a day (incentives.ts,
 * reports.ts, mobile EarningsScreen) get the correct day/month total
 * instead of double-counting the running cumulative.
 *
 * calculateDeliveryIncentive still also returns the CUMULATIVE
 * incentiveAmount (the running day total as of this trip) for callers /
 * tests that want it; only the per-trip incentiveThisTrip is persisted.
 *
 * Time handling: all weekday/off-peak and daily-reset logic runs in
 * Malaysia time (MYT, fixed UTC+8, no daylight saving) so that a server
 * running in UTC still bins trips into the correct local trip-day and rate.
 */

// Reads an hour-of-day (0–23) from an env var, falling back to `fallback`
// if the var is unset or not a valid integer in range.
function hourFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

// Off-peak cutoff (brief Section 3, open question 1 — was 6pm/9pm placeholder).
// Override with OFFPEAK_CUTOFF_HOUR in the API env; defaults to 18 (6pm).
export const OFFPEAK_CUTOFF_HOUR = hourFromEnv("OFFPEAK_CUTOFF_HOUR", 18);

// Daily trip-counter reset hour (open question 2 — midnight vs 7am placeholder).
// Override with DAILY_RESET_HOUR in the API env; defaults to 0 (midnight).
export const DAILY_RESET_HOUR = hourFromEnv("DAILY_RESET_HOUR", 0);

// Malaysia is UTC+8 year-round (no daylight saving). We add this offset to a
// UTC instant and then read the UTC* fields to get the wall-clock MYT parts.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// Malaysian public holidays 2026 (brief Section 18), deduped to "YYYY-MM-DD".
// On these dates the off-peak rate table applies all day.
// TODO: make this admin-configurable (store in DB) instead of hardcoding.
export const MY_PUBLIC_HOLIDAYS_2026: Set<string> = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-29", // Chinese New Year
  "2026-01-30", // Chinese New Year (2nd day)
  "2026-02-01", // Federal Territory Day
  "2026-03-28", // Hari Raya Aidilfitri
  "2026-03-29", // Hari Raya Aidilfitri (2nd day)
  "2026-04-14", // Thaipusam (Penang)
  "2026-05-01", // Labour Day
  "2026-05-20", // Wesak Day
  "2026-06-05", // Hari Raya Aidiladha
  "2026-06-08", // Yang di-Pertuan Agong Birthday
  "2026-07-07", // Awal Muharram
  "2026-08-31", // National Day
  "2026-09-16", // Malaysia Day / Prophet Muhammad Birthday (same date in brief)
  "2026-10-20", // Deepavali
  "2026-12-25", // Christmas
]);

/** The Malaysia-time (UTC+8) wall-clock parts of a UTC instant. */
function mytParts(date: Date): { year: number; month: number; day: number; hour: number; weekday: number } {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  return {
    year: myt.getUTCFullYear(),
    month: myt.getUTCMonth(), // 0-11
    day: myt.getUTCDate(),
    hour: myt.getUTCHours(),
    weekday: myt.getUTCDay(), // 0 = Sunday, 6 = Saturday
  };
}

/** The trip's date as a Malaysia-time "YYYY-MM-DD" string. */
function mytDateKey(date: Date): string {
  const p = mytParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/**
 * Weekday rates apply Mon-Fri before the off-peak cutoff (Malaysia time).
 * Off-peak rates apply on Sat/Sun, on public holidays, or any day at/after
 * the cutoff hour — all evaluated against the trip's Malaysia-time wall clock.
 */
export function isOffPeak(date: Date): boolean {
  const { weekday, hour } = mytParts(date);
  if (weekday === 0 || weekday === 6) return true; // Sat / Sun
  if (MY_PUBLIC_HOLIDAYS_2026.has(mytDateKey(date))) return true; // public holiday
  return hour >= OFFPEAK_CUTOFF_HOUR;
}

/**
 * Start of the "trip day" that `date` falls into, per DAILY_RESET_HOUR, in
 * Malaysia time. Returns the UTC instant corresponding to DAILY_RESET_HOUR:00
 * MYT on the trip's MYT day.
 */
export function getTripDayStart(date: Date): Date {
  const p = mytParts(date);
  // The MYT calendar day this trip belongs to; if the trip's MYT hour is
  // before the reset hour, it belongs to the previous MYT day.
  let { year, month, day } = p;
  if (p.hour < DAILY_RESET_HOUR) {
    day -= 1; // Date.UTC normalises day=0 / negatives into the prior month/year
  }
  // DAILY_RESET_HOUR:00 MYT expressed as a UTC instant.
  return new Date(Date.UTC(year, month, day, DAILY_RESET_HOUR) - MYT_OFFSET_MS);
}

export function getTripDayEnd(date: Date): Date {
  const start = getTripDayStart(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Step 2 — the key rule: first trip of the day earns full destination
 * points, every later trip earns exactly 1 point regardless of destination.
 */
export function computeTripPoints(sequenceNumberToday: number, destinationPoints: number): number {
  return sequenceNumberToday === 1 ? destinationPoints : 1;
}

/**
 * Step 3 — documentation gate. A delivery cannot be finalized until the DO
 * photo is uploaded, and (only when the destination zone is K2) the K2
 * customs form is acknowledged.
 *
 * TODO confirm with Mr. Teh: is the K2 form a checkbox ack or a real file
 * upload (open question 3)? Treated as a boolean ack for now — actual file
 * upload is Phase 4+.
 */
export function isDocumentationComplete(
  stop: { do_uploaded: boolean; k2_form_ack: boolean },
  destinationZoneCode: string
): boolean {
  if (!stop.do_uploaded) return false;
  if (destinationZoneCode === "K2" && !stop.k2_form_ack) return false;
  return true;
}

/** Steps 4 & 5 — deduction then final RM calculation. */
export function calculateIncentiveAmount(params: {
  totalPointsToday: number;
  dailyDeductionPoints: number;
  rate: number;
}): number {
  const netPoints = Math.max(params.totalPointsToday - params.dailyDeductionPoints, 0);
  return Math.round(netPoints * params.rate * 100) / 100;
}

export interface DeliveryIncentiveResult {
  sequenceNumberToday: number;
  pointsEarnedThisTrip: number;
  totalPointsToday: number;
  isOffPeak: boolean;
  rateUsed: number;
  /** Running day total (cumulative) as of this trip. */
  incentiveAmount: number;
  /**
   * MARGINAL incentive this trip alone contributes — the value to persist in
   * incentive_earned. floored(day total WITH this trip) − floored(day total
   * BEFORE this trip), so summing it across a day reproduces the day total.
   */
  incentiveThisTrip: number;
}

/**
 * Full per-delivery calculation. Callers must supply:
 *  - completedTripsTodayBeforeThis: how many trips this driver already
 *    delivered earlier in the same trip-day (NOT including this one)
 *  - firstTripPointsToday: the points trip #1 of the day earned (its
 *    destination points). Only needed when this isn't trip #1; pass null
 *    for trip #1 itself.
 *  - destinationPoints: this trip's destination points (used only if this
 *    turns out to be trip #1 of the day)
 */
export function calculateDeliveryIncentive(params: {
  pickupDateTime: Date;
  destinationPoints: number;
  completedTripsTodayBeforeThis: number;
  firstTripPointsToday: number | null;
  truck: {
    daily_deduction_points: number;
    entitled_claim_weekday: number;
    entitled_claim_offpeak: number;
  };
}): DeliveryIncentiveResult {
  const sequenceNumberToday = params.completedTripsTodayBeforeThis + 1;
  const pointsEarnedThisTrip = computeTripPoints(sequenceNumberToday, params.destinationPoints);

  // Points contributed by every trip before this one today: trip #1's
  // destination points, plus exactly 1 point for each trip in between.
  const pointsFromPriorTrips =
    sequenceNumberToday === 1 ? 0 : (params.firstTripPointsToday ?? 0) + (sequenceNumberToday - 2);

  const totalPointsToday = pointsFromPriorTrips + pointsEarnedThisTrip;

  const offPeak = isOffPeak(params.pickupDateTime);
  const rate = offPeak ? params.truck.entitled_claim_offpeak : params.truck.entitled_claim_weekday;

  // Cumulative day total WITH this trip (the running figure).
  const incentiveAmount = calculateIncentiveAmount({
    totalPointsToday,
    dailyDeductionPoints: params.truck.daily_deduction_points,
    rate,
  });

  // Cumulative day total BEFORE this trip, using the same deduction + rate.
  // The deduction is applied to the whole day's points (not per trip), so the
  // marginal of trip #1 absorbs the full deduction and later trips add their
  // own (post-deduction) points × rate.
  const incentiveBeforeThisTrip = calculateIncentiveAmount({
    totalPointsToday: pointsFromPriorTrips,
    dailyDeductionPoints: params.truck.daily_deduction_points,
    rate,
  });

  // MARGINAL incentive this trip adds — the value stored in incentive_earned.
  const incentiveThisTrip = Math.round((incentiveAmount - incentiveBeforeThisTrip) * 100) / 100;

  return {
    sequenceNumberToday,
    pointsEarnedThisTrip,
    totalPointsToday,
    isOffPeak: offPeak,
    rateUsed: rate,
    incentiveAmount,
    incentiveThisTrip,
  };
}
