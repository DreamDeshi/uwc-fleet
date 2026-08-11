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
}

/**
 * Re-price a proposal from the off-peak rate to the weekday rate.
 *
 * Exact rather than a rescale: the engine's last step is `marginalPoints ×
 * rate`, so dividing the proposal by the rate it used recovers the points it was
 * actually paid for — already net of the daily deduction and (interplant) the
 * round-trip halving. Multiplying those by the weekday rate is precisely what
 * the engine would have produced had the tier been weekday.
 *
 * Returns null when that recovery is not exact — a rate of 0, or points that do
 * not come back as a whole number. Money is never adjusted on an inference.
 */
export function weekdayEquivalent(params: {
  proposed: number;
  rateUsed: number;
  weekdayRate: number;
}): { amount: number; points: number } | null {
  if (!(params.rateUsed > 0) || !(params.weekdayRate > 0)) return null;
  const points = params.proposed / params.rateUsed;
  // Tolerance, not equality: the proposal is rounded to cents on the way in.
  if (Math.abs(points - Math.round(points)) > 1e-6) return null;
  const whole = Math.round(points);
  return { amount: Math.round(whole * params.weekdayRate * 100) / 100, points: whole };
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
      truck: { select: { entitled_claim_weekday: true, entitled_claim_offpeak: true } },
      stops: { select: { delivered_at: true } },
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
  const priced = weekdayEquivalent({
    proposed: Number(trip.incentive_earned),
    rateUsed: Number(trip.rate_used ?? 0),
    weekdayRate,
  });
  // Never RAISE a proposal here. This rule only ever removes an off-peak
  // premium; if the arithmetic came out higher, something is wrong with the
  // recovery and the proposal stands.
  if (!priced || priced.amount > Number(trip.incentive_earned)) return null;

  return {
    amount: priced.amount,
    points: priced.points,
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
