/**
 * Incentive engine — Development Brief Section 3.
 *
 * All functions here are pure (no DB, no Date.now()) so they can be unit
 * tested directly. The trips route is responsible for fetching the data
 * these functions need and passing it in.
 *
 * Design decision: incentive_earned on a Trip stores the driver's
 * CUMULATIVE incentive for the calendar day as of that trip's delivery
 * (matches the brief's worked example, which only ever shows a running
 * day total, never a per-trip slice). Earlier trips' incentive_earned
 * values are not rewritten when a later trip is delivered.
 */

// TODO confirm with Mr. Teh: off-peak cutoff is 6pm or 9pm (brief Section 3, open question 1).
export const OFFPEAK_CUTOFF_HOUR = 18;

// TODO confirm with Mr. Teh: daily trip counter reset time — midnight or 7am (open question 2).
export const DAILY_RESET_HOUR = 0;

/**
 * Weekday rates apply Mon-Fri before the off-peak cutoff.
 * Off-peak rates apply on Sat/Sun, or any day at/after the cutoff hour.
 * Public holidays are NOT modeled yet — no holiday calendar exists in Phase 2.
 */
export function isOffPeak(date: Date): boolean {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return true;
  return date.getHours() >= OFFPEAK_CUTOFF_HOUR;
}

/** Start of the "trip day" that `date` falls into, per DAILY_RESET_HOUR. */
export function getTripDayStart(date: Date): Date {
  const start = new Date(date);
  if (start.getHours() < DAILY_RESET_HOUR) {
    start.setDate(start.getDate() - 1);
  }
  start.setHours(DAILY_RESET_HOUR, 0, 0, 0);
  return start;
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
  incentiveAmount: number;
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

  const incentiveAmount = calculateIncentiveAmount({
    totalPointsToday,
    dailyDeductionPoints: params.truck.daily_deduction_points,
    rate,
  });

  return {
    sequenceNumberToday,
    pointsEarnedThisTrip,
    totalPointsToday,
    isOffPeak: offPeak,
    rateUsed: rate,
    incentiveAmount,
  };
}
