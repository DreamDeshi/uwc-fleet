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

// The weekday PEAK band is 08:00–17:59 — BOTH ends come from the authoritative
// spec workbook ("TRUCK BOOKING SYSTEM (YS).xlsx", INTERNAL LORRY RATE sheet),
// whose peak rate table is headed "Lorry / Type (Weekday 8am - 6pm)" and whose
// off-peak table is headed "Public Holiday / Saturday - Sunday / Weekday after
// 6pm". The two tables are the only rate tables and every weekday hour must be
// priced by exactly one of them, so the peak table's own "8am" lower bound is
// what makes 00:00–07:59 off-peak: those hours are simply not inside 8am–6pm.
// This is spec, NOT a placeholder — env-tunable for flexibility only.
//
// PEAK_START_HOUR existed implicitly as 0 until 17 Jul 2026, which priced
// weekday 00:00–07:59 at the PEAK rate — contradicting the peak table's header
// and UNDERPAYING drivers (off-peak is the higher rate on most lorries, e.g.
// PLX 2406 RM13 off-peak vs RM11 peak). It bites on the delivery-confirm
// anchor: a driver closing a late-running evening run at 00:30 was paid peak.
// Reachable rarely before the 02:00 pickup window (item 12), routine after it.
export const OFFPEAK_CUTOFF_HOUR = hourFromEnv("OFFPEAK_CUTOFF_HOUR", 18);
export const PEAK_START_HOUR = hourFromEnv("PEAK_START_HOUR", 8);

// Incentive-day reset hour = midnight (00:00). CONFIRMED by Mr. Teh's written
// answer Q1 (3 Jul 2026): "after 12am points refresh for next day". Env-tunable
// only; not an open question.
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
 * Weekday (peak) rates apply Mon-Fri inside [PEAK_START_HOUR, OFFPEAK_CUTOFF_HOUR)
 * — 08:00–17:59 MYT. Off-peak rates apply on Sat/Sun, on public holidays, or on
 * a weekday at/after the cutoff hour OR before the peak start hour; the two
 * bands partition the day, so every instant is priced exactly once.
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
  // Outside the workbook's "Weekday 8am - 6pm" peak band, either end.
  return hour >= OFFPEAK_CUTOFF_HOUR || hour < PEAK_START_HOUR;
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

/** One drop's score plus WHY: whether the repeat rule (flat 1) fired. */
export interface ScoredDropResult {
  points: number;
  /**
   * True iff the flat-1 repeat branch was taken — NOT derivable from points
   * alone (a 1-point zone's FIRST drop also scores 1, but is not a repeat).
   * Persisted at finalization so the clerk can answer "why only 1 point?".
   */
  wasRepeat: boolean;
}

export function scoreDropsDetailed(
  drops: ScoredDrop[],
  zonesAlreadyHitToday: Iterable<string> = []
): ScoredDropResult[] {
  // `seen` starts pre-loaded with every zone the driver already delivered to
  // earlier today (on previous trips), so a repeat zone scores 1 even when the
  // first visit happened on a different trip.
  const seen = new Set<string>(zonesAlreadyHitToday);
  return drops.map((d) => {
    // First visit to a zone today → the zone's full points. Any repeat → flat 1.
    // Different zones don't affect each other: three drops in three new zones
    // all earn full points.
    const wasRepeat = seen.has(d.zoneCode);
    const points = wasRepeat ? 1 : d.zonePoints;
    seen.add(d.zoneCode); // remember it, so the NEXT drop here counts as a repeat
    return { points, wasRepeat };
  });
}

/** Points-only view of scoreDropsDetailed — the original public shape. */
export function scoreDrops(
  drops: ScoredDrop[],
  zonesAlreadyHitToday: Iterable<string> = []
): number[] {
  return scoreDropsDetailed(drops, zonesAlreadyHitToday).map((d) => d.points);
}

/**
 * The ONE zone whose deliveries need a customs document before they can be
 * marked delivered.
 *
 * ⚠ THIS IS "P1" (Penang Island), NOT the zone literally CALLED "K2".
 *
 * Mr. Teh, R3 2026-07-29: "Only Penang bayan Lepas area require K2, but I think
 * you just let them upload any document will do." Bayan Lepas is on Penang
 * Island = zone P1. The gate had been keyed on zone code "K2" (Sungai Petani +
 * Kuala Ketil) because the FEATURE is named after Borang K2 — the customs form
 * — and the zone code "K2" is an unrelated coincidence of naming. So the gate
 * fired on the wrong towns from the day it shipped, blocking Delivered (and
 * therefore pay) in Sungai Petani / Kuala Ketil while letting Bayan Lepas
 * through. Owner decision, 29 Jul: retarget the zone, keep it zone-gated.
 *
 * Named, not inlined, precisely so this can never drift back to a bare string
 * comparison that reads like it means the zone with the matching name.
 */
export const CUSTOMS_DOC_ZONE = "P1";

/**
 * …and the AREA inside it. Zone P1 is the whole of Penang Island — 412
 * consignees on prod, of which only 192 are in Bayan Lepas. Gating the zone
 * would have demanded a customs document from George Town, Jelutong, Gelugor
 * and 220 others Mr. Teh never named, blocking Delivered (and pay) at each —
 * the same class of bug this change exists to fix, aimed at different towns.
 * Owner decision 29 Jul: gate the AREA, not the zone.
 */
export const CUSTOMS_DOC_AREA = "BAYAN LEPAS";

/**
 * `area` is FREE TEXT typed by requestors, so it is normalised before
 * comparison — upper-cased, trimmed, and internal runs of whitespace
 * collapsed. Matching is `includes`, not equality, because real rows read
 * "KAWASAN PERINDUSTRIAN BAYAN LEPAS" and "BAYAN LEPAS FIZ" as often as the
 * bare name, and a stricter test would silently un-gate them.
 */
function normaliseArea(area: string | null | undefined): string {
  return (area ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * True when this delivery must carry a customs document.
 *
 * FAILS OPEN by design. A blank or unrecognised area does NOT gate — owner
 * ruling 29 Jul: "a missing document is recoverable at POD approval; a
 * stranded driver isn't." A consignee added by a requestor who typed nothing
 * into `area` therefore delivers normally, and the admin catches the missing
 * document at approval, which is where a human is already looking.
 */
export function requiresCustomsDoc(
  destinationZoneCode: string,
  destinationArea?: string | null
): boolean {
  if (destinationZoneCode !== CUSTOMS_DOC_ZONE) return false;
  return normaliseArea(destinationArea).includes(CUSTOMS_DOC_AREA);
}

/**
 * Step 3 — documentation gate. A delivery cannot be finalized until the DO
 * photo is uploaded, and (only in the customs-document zone above) a customs
 * document has been UPLOADED.
 *
 * Mr. Teh, R1 2026-07-24 Q6: "Prefer they need upload the form … we need admin
 * to final validate and approve, only they can get pay." So the gate keys on
 * the uploaded document (`k2_photo`), NOT the legacy `k2_form_ack` tick. Admin
 * validation + approval is the existing POD/incentive-approval gate (16 Jul
 * 2026): the document rides in the trip payload for the admin to review.
 *
 * WHAT the document is, is deliberately NOT checked — R3 2026-07-29: "you just
 * let them upload any document will do." The server has never inspected the
 * file and must not start; the admin reviewing it at approval is the check.
 *
 * This is a DOCUMENT gate only — no incentive amount or rate calculation
 * changes. `k2_photo` keeps its column name (the schema is frozen).
 */
export function isDocumentationComplete(
  stop: { do_uploaded: boolean; k2_photo: string | null; pod_photo: string | null },
  destinationZoneCode: string,
  destinationArea?: string | null
): boolean {
  // The gate is the actual POD PHOTO, not the do_uploaded flag alone — the
  // flag is set by the photo upload, but checking only the boolean let it be
  // self-attested via PATCH /docs with no photo behind it (audit finding).
  if (!stop.pod_photo) return false;
  if (!stop.do_uploaded) return false;
  if (requiresCustomsDoc(destinationZoneCode, destinationArea) && !stop.k2_photo) return false;
  return true;
}

export interface DeliveryIncentiveResult {
  isOffPeak: boolean;
  rateUsed: number;
  /** Points each of THIS trip's drops earned, pre-deduction (per-zone rule). */
  dropPoints: number[];
  /** Whether each drop scored as a same-zone repeat (index-aligned with dropPoints). */
  wasRepeat: boolean[];
  /** Sum of dropPoints (pre-deduction) for this trip. */
  pointsThisTrip: number;
  /**
   * Deduction points THIS trip's group actually absorbed (= groupPoints −
   * marginalPoints). Summed across a driver-day it equals min(dayTotal,
   * deduction) — the deduction is spent exactly once, at the day-total level.
   */
  deductionApplied: number;
  /**
   * Points this group did NOT get paid because the day's interplant legs do not
   * yet make up whole round trips (R5 A2). 0 on every customer/supplier trip and
   * on any interplant group that completes a pair. Kept SEPARATE from
   * `deductionApplied` because interplant takes no deduction at all — folding
   * the halving into that field would print a deduction the client says does not
   * exist, on the one kind of work that has none.
   */
  roundTripShortfall: number;
  /**
   * MARGINAL incentive (RM) this trip's group contributes — the value persisted
   * in incentive_earned. Computed as the floored day-total WITH this group minus
   * the floored day-total BEFORE it, so summing across a day telescopes to
   * max(dayTotalPoints − deduction, 0) × rate — the daily deduction spent once,
   * on the day's TOTAL (workbook rule), never double-counted.
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
 *  - priorPointsToday: the driver's cumulative SCORED points already delivered
 *    earlier today (across prior trips), before this group. 0 iff this group
 *    holds the day's first drop. This is what makes the daily deduction fold in
 *    at the DAY-TOTAL level (workbook rule), telescoping across trips.
 *
 * "Today" above means the MYT day the drops were DELIVERED, and rateDateTime
 * is the delivery-confirm anchor — per the client rule (3 Jul 2026) that
 * points calculate on delivery confirm time, not pickup time. The route layer
 * groups a trip's stops per delivery day (groupStopsByDeliveryDay) and calls
 * this once per group.
 *
 * DEDUCTION (workbook, INTERNAL LORRY RATE sheet — "accumulate TOTAL 20 trip
 * incentive point per day … calculate as 18 point (minus 2)"): the truck's daily
 * deduction is subtracted ONCE per driver per day from the day's TOTAL points,
 * floored at 0. We implement that as a marginal: this group contributes
 *   max(priorPointsToday + groupPoints − deduction, 0)
 *   − max(priorPointsToday − deduction, 0)   [× rate]
 * so summing every trip's marginal over a driver-day telescopes to
 * max(dayTotalPoints − deduction, 0) × rate — deduction spent once, at the
 * total. Correct even under concurrent/out-of-order finalization because the
 * caller derives priorPointsToday from drops delivered STRICTLY BEFORE this
 * group's anchor (the dayLedger delivered_at bound). A low-point first drop
 * (e.g. P2 = 1pt) no longer loses the excess deduction — it carries across the
 * day, exactly as the sheet's day-total subtraction requires.
 *
 * Worked example (unit-test anchor): PLX 2406 weekday, day's first trip, one
 * drop in Ipoh (A2 = 6). priorPointsToday = 0; deduction 2; rate RM11.
 *   marginal = max(0+6−2,0) − max(0−2,0) = 4 − 0 = 4 pts → (6 − 2) × 11 = RM44.
 */
export function calculateDeliveryIncentive(params: {
  /** The delivery-confirm instant the weekday/off-peak tier is read from (the day group's first delivered_at). */
  rateDateTime: Date;
  drops: ScoredDrop[];
  zonesDeliveredEarlierToday: string[];
  /** The driver's cumulative SCORED points delivered earlier today, before this group (0 iff day's first drop). */
  priorPointsToday: number;
  /** MYT "YYYY-MM-DD" holiday keys from the PublicHoliday table (caller-supplied — the engine never reads the DB). */
  publicHolidays: ReadonlySet<string>;
  truck: {
    daily_deduction_points: number;
    entitled_claim_weekday: number;
    entitled_claim_offpeak: number;
  };
  /**
   * INTERPLANT ONLY — pay the day's points in whole ROUND TRIPS (R5 A2, 11 Aug
   * 2026). See the halving note in the function doc. Defaults false, so every
   * customer/supplier trip is bit-for-bit unchanged.
   */
  roundTripHalving?: boolean;
}): DeliveryIncentiveResult {
  // Peak vs off-peak is decided ONCE per delivery-day group, from the group's
  // first delivery-confirm time in MYT (client rule 3 Jul 2026 — was pickup
  // time before). Not re-evaluated per stop within the group.
  const offPeak = isOffPeak(params.rateDateTime, params.publicHolidays);
  // Each truck carries its own two rates (e.g. PLX 2406: RM11 weekday / RM13
  // off-peak), so picking the rate is just a field lookup.
  const rate = offPeak ? params.truck.entitled_claim_offpeak : params.truck.entitled_claim_weekday;

  const scored = scoreDropsDetailed(params.drops, params.zonesDeliveredEarlierToday);
  const dropPoints = scored.map((d) => d.points);
  const groupPoints = dropPoints.reduce((a, b) => a + b, 0);

  // Daily deduction folds in at the DAY TOTAL, floored at 0 (workbook rule; see
  // the function doc). The marginal = floored day-total WITH this group minus
  // floored day-total BEFORE it, so the deduction is spent exactly once across
  // the driver-day and a low-point first drop carries the excess forward.
  const deduction = params.truck.daily_deduction_points;
  const beforeDeducted = Math.max(params.priorPointsToday - deduction, 0);
  const withDeducted = Math.max(params.priorPointsToday + groupPoints - deduction, 0);
  // How much of the deduction THIS group absorbed (0 when the day's earlier
  // drops already covered it; the full deduction when this group holds enough
  // of the day's first points). Sums to min(dayTotal, deduction) over the day.
  // Measured BEFORE the halving below, so the two never contaminate each other.
  const deductionApplied = groupPoints - (withDeducted - beforeDeducted);

  // ── R5 A2 — INTERPLANT IS PAID IN WHOLE ROUND TRIPS ──────────────────────
  //
  // Mr. Teh, 11 Aug 2026, answering "an interplant round trip — one booking or
  // two?" with Option B (two bookings) and then pricing it himself:
  //
  //   "if particular intercompany delivery 18points for that day, then he will
  //    get pay only for 9 points (18 divide by 2), if the interplant point is
  //    17point for whole days, then he will only entitle for 8 points"
  //
  // Not a new rule — it is the round-trip rule stated arithmetically. The
  // workbook has said since 29 Jul "SEND AND RETRUN WITH CARGO ONLY CAN
  // CONSIDER 1 TRIP COUNT", and each leg is its own booking scoring 1 point, so
  // legs ÷ 2 = round trips. 17 → 8, not 8.5 and not 9: FLOOR, because the odd
  // leg is an INCOMPLETE round trip and earns nothing yet.
  //
  // ⚠ HALVE THE DAY, NOT THE TRIP. He counts "for that day", which is what
  // removes the Delivery-to-Return matching problem entirely — no pairing
  // heuristic, no guessing which Return belongs to which Delivery. Applying it
  // per trip instead would pay 0 for every single-leg booking forever, which is
  // every interplant booking he has described.
  //
  // It therefore telescopes exactly like the deduction, over the same running
  // day total: floor(with/2) − floor(before/2) summed across a driver-day is
  // floor(dayTotal/2). The consequence, stated plainly: the day's FIRST leg
  // pays RM0 and the pay lands on the second. That is the rule, not a bug — but
  // it is the first place in this system where a completed trip legitimately
  // earns nothing, so it is on the first-payroll watch list.
  //
  // ⚠ THE MIDNIGHT STRADDLE — KNOWN, REACHABLE, AND UNRESOLVED.
  // Halving the DAY means a round trip split by the day boundary pays NOTHING:
  // floor(1/2) on Monday plus floor(1/2) on Tuesday is 0 + 0, for a genuine
  // completed round trip — the exact case the rule exists to reward. The loss is
  // total, not partial, and there is no carry-forward: an unpaired leg is lost
  // when its day closes.
  //
  // Two ways in, neither exotic:
  //   1. the Return is BOOKED for the next morning (send Monday evening, return
  //      Tuesday) — an ordinary industrial pattern that nothing forbids, since
  //      each leg sits inside its own day's operating window;
  //   2. one booking whose two stops straddle midnight — the "rare midnight
  //      straddler" this file already handles, which splits into two day groups
  //      of one point each.
  //
  // NOT FIXED HERE, deliberately. Every repair pairs legs across a day boundary,
  // and pairing is precisely what his day-level counting removed ("18points for
  // that day"). Choosing a pairing rule now would be inventing the answer to a
  // question he was never asked. Pinned instead by the MIDNIGHT STRADDLE block
  // in tests/interplantRoundTrip.test.ts, so the next reader meets it in a test
  // rather than in a driver's complaint, and logged as an open item.
  const payable = (points: number) => (params.roundTripHalving ? Math.floor(points / 2) : points);
  const beforePoints = payable(beforeDeducted);
  const withPoints = payable(withDeducted);
  const marginalPoints = withPoints - beforePoints;
  const roundTripShortfall = withDeducted - beforeDeducted - marginalPoints;
  const incentive = marginalPoints * rate;

  return {
    isOffPeak: offPeak,
    rateUsed: rate,
    dropPoints,
    wasRepeat: scored.map((d) => d.wasRepeat),
    pointsThisTrip: dropPoints.reduce((a, b) => a + b, 0),
    deductionApplied,
    roundTripShortfall,
    // Rounded to cents so the persisted RM value is clean (money is Decimal in
    // the DB, but the engine works in plain numbers for testability).
    incentiveThisTrip: Math.round(incentive * 100) / 100,
  };
}
