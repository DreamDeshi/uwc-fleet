import type { Prisma } from "@prisma/client";
import { getTripDayEnd } from "./incentiveEngine";
import { LEDGER_TRIP_STATUSES } from "./dayLedger";

/**
 * R5 A4 — ONLY THE LAST TRIP OF THE DAY EARNS THE AFTER-6PM RATE.
 *
 * Mr. Teh, 11 Aug 2026, asked whether an earlier trip that gets back after 6pm
 * earns the off-peak rate: "Option A…last drop point of the delivery only count
 * OT". Option A as put to him was "Only the LAST trip of the day can earn the
 * after-6pm rate". On PND 1888 that is RM11 vs RM13 a point — RM12 on a 6-point
 * Ipoh run, in his own framing of the question.
 *
 * ── WHY THIS RUNS AT APPROVAL AND NOT AT FINALIZATION ────────────────────────
 *
 * A trip finalizes the instant its last stop is delivered, and the one-active
 * rule makes a driver's trips serial — so trip 1 ALWAYS finalizes before trip 2
 * exists. At the moment the money is proposed, "is this the day's last trip" is
 * not merely unknown, it is unknowable.
 *
 * Approval is the last moment before the number becomes permanent: it is the
 * only writer of `incentive_final`, it is a write-once CAS on
 * `status: pending_approval`, and after it BL9 applies — no route rewrites an
 * approved incentive. A decision that depends on the rest of the day therefore
 * belongs here, where the rest of the day has usually happened. Owner ruling,
 * 12 Aug 2026, choosing this over two alternatives:
 *
 *   - deciding at finalization with a lookahead — in the serial flow it never
 *     sees the later trip, so it grants OT in exactly the case he was asked
 *     about;
 *   - clawing the overpayment back out of the later trip's marginal (the shape
 *     the deduction uses) — correct on the day total, but a trip's figure then
 *     stops matching its own points and can be driven to zero.
 *
 * ⚠ THE HOLE, NAMED: an admin who approves trip 1 before the driver's day ends
 * sees no later trip and approves the off-peak figure. That is operational, not
 * silent — the approver chooses when to approve — but nothing prevents it.
 *
 * ── WHAT COUNTS AS "A LATER TRIP" ────────────────────────────────────────────
 *
 * Any OTHER trip of the same driver, in the same MYT delivery day, carrying a
 * stop the driver DELIVERED or ARRIVED AT after this trip's last delivery
 * confirm. Arrivals count deliberately: a later trip where every stop failed is
 * still a later trip, and counting it can only ever DEMOTE — the direction that
 * cannot overpay, which is the one BL9 makes irreversible.
 *
 * NOT pool-filtered. The interplant/customer split (11 Aug) is about which drops
 * SCORE against each other; "the last trip of the day" is about the driver's
 * working day, and a plant run at 9pm means the 6:40pm customer trip was not the
 * last time he came back to Batu Kawan.
 *
 * ⚠ This does NOT touch the FROZEN question of which timestamp selects a trip's
 * rate tier (AGENTS.md). The tier is still chosen at finalization, from the
 * group's first delivery confirm, exactly as before. This only asks whether a
 * trip that already qualified is ALLOWED to keep it.
 */

/** Trips whose stops prove the driver went out again — same set the ledger uses. */
const LATER_TRIP_STATUSES = [...LEDGER_TRIP_STATUSES];

export interface OtDemotion {
  /** The amount to approve instead of the proposal. */
  amount: number;
  /** Points the trip was actually paid for (post-deduction, post-halving). */
  points: number;
  weekdayRate: number;
  offPeakRate: number;
  /** Where the paid points came from — "stored" is the norm; see IM10. */
  source: "stored" | "money";
}

/**
 * HOW MANY POINTS THIS TRIP WAS ACTUALLY PAID FOR.
 *
 * ⚠ READ THE POINTS, DO NOT REVERSE-ENGINEER THEM FROM RINGGIT. `points_awarded`
 * is persisted per stop and `deduction_applied` per trip (IM8's lesson), so the
 * paid points are a stored fact:
 *
 *     Σ points_awarded − deduction_applied
 *
 * Dividing the money back out would work today — the engine's last step is
 * `marginalPoints × rate` and the deduction reduces POINTS rather than ringgit,
 * so the quotient is whole even on a trip carrying the deduction — but it is a
 * derivation that quietly stops being true the moment anything else is withheld,
 * and its failure mode is "leave the proposal standing", which is invisible.
 *
 * ⚠ THE ONE CASE THE POINTS CANNOT EXPRESS, and it is live: an INTERPLANT trip
 * post-R5 A2. The round-trip halving withholds points, and that shortfall has
 * nowhere to be stored — `roundTripShortfall` is computed and dropped, which is
 * open item IM10. On such a trip Σ points_awarded OVERSTATES what was paid. So
 * the money quotient stays as a second candidate, and the identity check below
 * is what decides between them rather than a guess. When IM10's column lands,
 * the points path covers interplant too and the fallback stops being reachable.
 *
 * Neither candidate is trusted on its own: whichever is used must satisfy
 * `points × rate_used == incentive_earned` to the cent. If neither does, the
 * proposal is not a shape this rule understands — so it is left alone, LOUDLY.
 * A silent "do nothing" is how a money rule reads clean and never fires.
 */
const CENT = 0.005;

/** Σ points_awarded − deduction_applied, or null if a stop was never scored. */
export function persistedPaidPoints(trip: {
  stops: { points_awarded: number | null; delivered_at: Date | null }[];
  deduction_applied: number | null;
}): number | null {
  let total = 0;
  for (const s of trip.stops) {
    // A stop that earned nothing (never reached) has no points row; a stop that
    // was DELIVERED with a null points_awarded means the trip was scored before
    // the breakdown existed, and the sum would silently under-read.
    if (s.points_awarded === null) {
      if (s.delivered_at) return null;
      continue;
    }
    total += s.points_awarded;
  }
  return total - (trip.deduction_applied ?? 0);
}

/** The money quotient — the fallback, and only where it proves itself. */
export function moneyPaidPoints(proposed: number, rateUsed: number): number | null {
  if (!(rateUsed > 0)) return null;
  const points = proposed / rateUsed;
  return Math.abs(points - Math.round(points)) > 1e-6 ? null : Math.round(points);
}

/**
 * Re-price a proposal from the off-peak rate to the weekday rate, using the
 * FIRST candidate that satisfies `points × rate_used == incentive_earned`.
 *
 * Returns null when neither does — money is never adjusted on an inference.
 */
export function weekdayEquivalent(params: {
  proposed: number;
  rateUsed: number;
  weekdayRate: number;
  /** Preferred source: the persisted points. Null when unavailable/unscored. */
  storedPoints: number | null;
}): { amount: number; points: number; source: "stored" | "money" } | null {
  if (!(params.rateUsed > 0) || !(params.weekdayRate > 0)) return null;
  const agrees = (points: number) =>
    Math.abs(points * params.rateUsed - params.proposed) < CENT;

  const candidates: { points: number | null; source: "stored" | "money" }[] = [
    { points: params.storedPoints, source: "stored" },
    { points: moneyPaidPoints(params.proposed, params.rateUsed), source: "money" },
  ];
  for (const c of candidates) {
    if (c.points === null || c.points < 0 || !agrees(c.points)) continue;
    return {
      amount: Math.round(c.points * params.weekdayRate * 100) / 100,
      points: c.points,
      source: c.source,
    };
  }
  return null;
}

type ApproveOtClient = Pick<Prisma.TransactionClient, "trip" | "tripStop">;

/**
 * Decide whether a trip awaiting approval must lose its off-peak rate.
 *
 * Returns null to leave the proposal alone — which covers every ordinary case:
 * a weekday trip, a trip that IS the day's last, a midnight straddler whose
 * groups used different tiers (`off_peak` NULL, so there is no single tier to
 * demote), and any trip whose points cannot be recovered exactly.
 */
export async function resolveLastTripOt(
  client: ApproveOtClient,
  tripId: string
): Promise<OtDemotion | null> {
  const trip = await client.trip.findUnique({
    where: { id: tripId },
    select: {
      driver_id: true,
      off_peak: true,
      rate_used: true,
      incentive_earned: true,
      entitled_claim_weekday: true,
      entitled_claim_offpeak: true,
      deduction_applied: true,
      truck: { select: { entitled_claim_weekday: true, entitled_claim_offpeak: true } },
      stops: { select: { delivered_at: true, points_awarded: true } },
    },
  });
  // off_peak is NULL for a multi-day-group trip (the rare midnight straddler):
  // its groups can hold different tiers, so there is no single one to demote.
  if (!trip || trip.off_peak !== true || trip.incentive_earned === null) return null;

  const lastDelivered = trip.stops.reduce<Date | null>(
    (latest, s) => (s.delivered_at && (!latest || s.delivered_at > latest) ? s.delivered_at : latest),
    null
  );
  if (!lastDelivered || !trip.driver_id) return null;

  // Anything the driver did LATER the same MYT day, on any other trip.
  const laterWindow = { gt: lastDelivered, lt: getTripDayEnd(lastDelivered) };
  const later = await client.tripStop.findFirst({
    where: {
      OR: [{ delivered_at: laterWindow }, { arrived_at: laterWindow }],
      trip: {
        driver_id: trip.driver_id,
        id: { not: tripId },
        status: { in: LATER_TRIP_STATUSES },
      },
    },
    select: { id: true },
  });
  if (!later) return null; // this IS the day's last trip — it keeps its OT

  // The snapshot pair, falling back to the truck for pre-rate-lock rows — the
  // same fallback finalization uses, so the two can never disagree.
  const weekdayRate = Number(trip.entitled_claim_weekday ?? trip.truck?.entitled_claim_weekday ?? 0);
  const proposed = Number(trip.incentive_earned);
  const rateUsed = Number(trip.rate_used ?? 0);
  const priced = weekdayEquivalent({
    proposed,
    rateUsed,
    weekdayRate,
    storedPoints: persistedPaidPoints(trip),
  });
  if (!priced) {
    // LOUD, not silent. Nothing here understands the proposal, so nothing here
    // touches it — but a money rule that quietly declines to fire is exactly the
    // failure this whole file is trying not to be.
    console.warn(
      `lastTripOt: leaving trip ${tripId} at its proposal — RM${proposed} at RM${rateUsed}/pt ` +
        `matches neither the stored points (${persistedPaidPoints(trip)}) nor a whole quotient`
    );
    return null;
  }
  // Never RAISE a proposal here. This rule only ever removes an off-peak
  // premium; if the arithmetic came out higher, something is wrong with the
  // recovery and the proposal stands.
  if (priced.amount > proposed) return null;

  return {
    amount: priced.amount,
    points: priced.points,
    source: priced.source,
    weekdayRate,
    offPeakRate: Number(trip.rate_used ?? trip.entitled_claim_offpeak ?? 0),
  };
}

/** Audit/override text — states the rule and both rates, not just the delta. */
export function otDemotionReason(d: OtDemotion): string {
  return (
    `R5 A4 — not the last trip of the day, so the after-6pm rate does not apply: ` +
    `${d.points} pt at RM${d.weekdayRate} instead of RM${d.offPeakRate}`
  );
}
