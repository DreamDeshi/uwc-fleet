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

/**
 * The trip's date as a Malaysia-time "YYYY-MM-DD" string — the key format the
 * PublicHoliday table stores and the leave calendar compares against.
 */
export function mytDateKey(date: Date): string {
  const p = mytParts(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/**
 * Weekday rates apply Mon-Fri before the off-peak cutoff (Malaysia time).
 * Off-peak rates apply on Sat/Sun, on public holidays, or any day at/after
 * the cutoff hour — all evaluated against the trip's Malaysia-time wall clock.
 *
 * `publicHolidays` is a set of MYT "YYYY-MM-DD" keys, supplied by the caller
 * (loaded from the admin-managed PublicHoliday table at the route layer).
 * The engine holds NO baked-in holiday list — an empty set simply means no
 * holidays, so this function stays pure and DB-free.
 */
export function isOffPeak(date: Date, publicHolidays: ReadonlySet<string>): boolean {
  const { weekday, hour } = mytParts(date);
  if (weekday === 0 || weekday === 6) return true; // Sat / Sun
  if (publicHolidays.has(mytDateKey(date))) return true; // public holiday
  return hour >= OFFPEAK_CUTOFF_HOUR;
}

/**
 * Start of the "trip day" that `date` falls into, per DAILY_RESET_HOUR, in
 * Malaysia time. Returns the UTC instant corresponding to DAILY_RESET_HOUR:00
 * MYT on the trip's MYT day.
 *
 * Client rule (Mr. Teh, 3 Jul 2026): the incentive day keys on DELIVERY
 * confirm time — feed this a stop's delivered_at, not the trip's pickup time.
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
 * One MYT delivery day's worth of a trip's delivered stops (client rule,
 * 3 Jul 2026: "points calculate on delivery confirm time; after 12am points
 * refresh for next day"). `anchor` is the group's first delivered_at — the
 * instant the weekday/off-peak rate tier is read from; dayStart/dayEnd bound
 * the "prior drops today" ledger query.
 */
export interface DeliveryDayGroup<T> {
  anchor: Date;
  dayStart: Date;
  dayEnd: Date;
  stops: T[];
}

/**
 * Split a trip's delivered stops into per-MYT-day groups by their
 * delivered_at. Almost always one group; a trip whose confirms straddle
 * midnight splits in two, and each day then scores against its OWN ledger,
 * earns its OWN daily deduction, and rates at its own confirm-time tier —
 * the pickup time plays no part in day attribution.
 *
 * `fallback` covers a delivered stop with a null delivered_at (defensive —
 * the delivered write always stamps it); callers pass the finalization moment.
 */
export function groupStopsByDeliveryDay<T extends { delivered_at: Date | null }>(
  stops: T[],
  fallback: Date
): DeliveryDayGroup<T>[] {
  const sorted = [...stops].sort(
    (a, b) =>
      (a.delivered_at ?? fallback).getTime() - (b.delivered_at ?? fallback).getTime()
  );
  const groups: DeliveryDayGroup<T>[] = [];
  for (const stop of sorted) {
    const at = stop.delivered_at ?? fallback;
    const dayStart = getTripDayStart(at);
    const current = groups[groups.length - 1];
    if (current && current.dayStart.getTime() === dayStart.getTime()) {
      current.stops.push(stop);
    } else {
      groups.push({ anchor: at, dayStart, dayEnd: getTripDayEnd(at), stops: [stop] });
    }
  }
  return groups;
}

/**
 * Step 2 — the key rule (client-confirmed): points are counted PER DROP POINT
 * (stop), PER ZONE, PER DAY, PER DRIVER.
 *   - The FIRST delivered drop into a given zone on a given day earns that
 *     zone's FULL points.
 *   - Every later delivered drop into the SAME zone that day earns 1 point.
 * The ledger spans both the stops within one trip and separate trips — order by
 * delivered_at and feed the zones already hit earlier today via
 * `zonesAlreadyHitToday`. Returns the points each drop earns, pre-deduction.
 */
export interface ScoredDrop {
  zoneCode: string;
  zonePoints: number; // the zone's full destination points
}

export function scoreDrops(
  drops: ScoredDrop[],
  zonesAlreadyHitToday: Iterable<string> = []
): number[] {
  // `seen` starts pre-loaded with every zone the driver already delivered to
  // earlier today (on previous trips), so a repeat zone scores 1 even when the
  // first visit happened on a different trip.
  const seen = new Set<string>(zonesAlreadyHitToday);
  return drops.map((d) => {
    // First visit to a zone today → the zone's full points. Any repeat → flat 1.
    // Different zones don't affect each other: three drops in three new zones
    // all earn full points.
    const points = seen.has(d.zoneCode) ? 1 : d.zonePoints;
    seen.add(d.zoneCode); // remember it, so the NEXT drop here counts as a repeat
    return points;
  });
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
  stop: { do_uploaded: boolean; k2_form_ack: boolean; pod_photo: string | null },
  destinationZoneCode: string
): boolean {
  // The gate is the actual POD PHOTO, not the do_uploaded flag alone — the
  // flag is set by the photo upload, but checking only the boolean let it be
  // self-attested via PATCH /docs with no photo behind it (audit finding).
  if (!stop.pod_photo) return false;
  if (!stop.do_uploaded) return false;
  if (destinationZoneCode === "K2" && !stop.k2_form_ack) return false;
  return true;
}

export interface DeliveryIncentiveResult {
  isOffPeak: boolean;
  rateUsed: number;
  /** Points each of THIS trip's drops earned, pre-deduction (per-zone rule). */
  dropPoints: number[];
  /** Sum of dropPoints (pre-deduction) for this trip. */
  pointsThisTrip: number;
  /** Deduction points actually subtracted (0 unless this trip holds the day's first drop). */
  deductionApplied: number;
  /**
   * MARGINAL incentive (RM) this trip contributes — the value persisted in
   * incentive_earned. Because the daily deduction is applied exactly once (on
   * the day's first drop, which lives in the first trip), summing this across a
   * day reproduces the day total without re-inflating.
   */
  incentiveThisTrip: number;
}

/**
 * Full per-trip incentive (Steps 2, 4 & 5), scoring the trip's drops with the
 * per-zone-per-day rule then applying the rate and the once-per-day deduction.
 *
 * Caller supplies:
 *  - drops: this trip's DELIVERED stops, in delivered order, each with its
 *    zone code and that zone's full destination points.
 *  - zonesDeliveredEarlierToday: zones this driver already delivered to earlier
 *    today (across prior trips) — so a stop whose zone was already hit scores 1.
 *  - isFirstDeliveredDropOfDay: true iff no drop was delivered earlier today
 *    (i.e. this trip holds the day's first drop, so the daily deduction lands
 *    on its first stop).
 *
 * "Today" above means the MYT day the drops were DELIVERED, and rateDateTime
 * is the delivery-confirm anchor — per the client rule (3 Jul 2026) that
 * points calculate on delivery confirm time, not pickup time. The route layer
 * groups a trip's stops per delivery day (groupStopsByDeliveryDay) and calls
 * this once per group.
 *
 * Worked example (this is the anchor case in the unit tests): PLX 2406 on a
 * weekday, day's first trip, one drop in Ipoh (A2 = 6 points). Ipoh is a new
 * zone so the drop earns the full 6; PLX's daily deduction is 2 and this is the
 * day's first drop, so it comes out here; weekday rate is RM11.
 *   → (6 − 2) × 11 = RM44.
 */
export function calculateDeliveryIncentive(params: {
  /** The delivery-confirm instant the weekday/off-peak tier is read from (the day group's first delivered_at). */
  rateDateTime: Date;
  drops: ScoredDrop[];
  zonesDeliveredEarlierToday: string[];
  isFirstDeliveredDropOfDay: boolean;
  /** MYT "YYYY-MM-DD" holiday keys from the PublicHoliday table (caller-supplied — the engine never reads the DB). */
  publicHolidays: ReadonlySet<string>;
  truck: {
    daily_deduction_points: number;
    entitled_claim_weekday: number;
    entitled_claim_offpeak: number;
  };
}): DeliveryIncentiveResult {
  // Peak vs off-peak is decided ONCE per delivery-day group, from the group's
  // first delivery-confirm time in MYT (client rule 3 Jul 2026 — was pickup
  // time before). Not re-evaluated per stop within the group.
  const offPeak = isOffPeak(params.rateDateTime, params.publicHolidays);
  // Each truck carries its own two rates (e.g. PLX 2406: RM11 weekday / RM13
  // off-peak), so picking the rate is just a field lookup.
  const rate = offPeak ? params.truck.entitled_claim_offpeak : params.truck.entitled_claim_weekday;

  const dropPoints = scoreDrops(params.drops, params.zonesDeliveredEarlierToday);

  // Daily deduction applied once/day on the first drop ('daily' per client). If
  // it should apply per new-zone instead, change here.
  let deductionApplied = 0;
  let incentive = 0;
  for (let i = 0; i < dropPoints.length; i++) {
    let points = dropPoints[i];
    if (params.isFirstDeliveredDropOfDay && i === 0) {
      // This trip holds the day's very FIRST drop, so the truck's daily
      // deduction comes out of it — exactly once per driver per day. Later
      // trips pass isFirstDeliveredDropOfDay=false and skip this entirely.
      const before = points;
      // TODO: zero-floor edge not client-confirmed (e.g. a 1pt P2 first drop
      // minus a 2pt deduction floors to 0; the unused deduction is not carried).
      points = Math.max(points - params.truck.daily_deduction_points, 0);
      deductionApplied = before - points; // what we actually took (may be < the full deduction if floored)
    }
    incentive += points * rate;
  }

  return {
    isOffPeak: offPeak,
    rateUsed: rate,
    dropPoints,
    pointsThisTrip: dropPoints.reduce((a, b) => a + b, 0),
    deductionApplied,
    // Rounded to cents so the persisted RM value is clean (money is Decimal in
    // the DB, but the engine works in plain numbers for testability).
    incentiveThisTrip: Math.round(incentive * 100) / 100,
  };
}
