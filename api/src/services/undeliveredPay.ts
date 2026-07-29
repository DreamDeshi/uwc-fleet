import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * WHICH STOPS EARN — the failed-delivery pay rule. MONEY PATH.
 *
 * Mr. Teh, R3 2026-07-29 Q11:
 *   (a) "Same rate paid, although not delivered"  — a stop the driver reached
 *       but could not deliver (customer closed etc.), after reason + photo +
 *       admin check, earns the SAME as a delivered stop.
 *   (b) "Yes paid"                                — stops delivered before a
 *       breakdown keep their pay (already true; the abort path pays them).
 *
 * Until now pay was gated strictly on `status = delivered`, so (a) earned
 * nothing. This module is the single place that decides what earns, kept pure
 * (no Prisma, no clock) so every branch is unit-tested — an untestable money
 * rule is exactly how the earlier proposal-vs-paid bug survived.
 *
 * ── THE THREE CONDITIONS FOR AN UNDELIVERED STOP TO EARN ────────────────────
 *
 * 1. NOT delivered. A delivered stop earns on the normal path; this guard is
 *    what stops a retried-then-delivered stop being counted twice.
 *
 * 2. `arrived_at` IS SET — the driver actually REACHED it. This is the line
 *    between his (a) and his (b): a breakdown halfway means the stops he never
 *    got to earn nothing ("if the lorry breakdown halfway, no incentive",
 *    16 Jul), and those stops have no arrival. We do not need to reason about
 *    the exception's CATEGORY to honour that — arrival is the physical fact.
 *
 * 3. A stop-attached exception that the admin BOTH verified AND closed with
 *    `resume`. Two conditions, because `current_state: "resolved"` alone is
 *    NOT an adjudication:
 *
 *      - `resolved` is produced by TWO different admin buttons — "Resume trip"
 *        and "Retry" — and BOTH are reachable straight from `reported` with no
 *        Verify at all (exceptionWorkflow.ALLOWED_FROM). Keying pay on it
 *        would mean an admin tapping Resume merely to unblock a stranded truck
 *        silently paid full zone points for a stop nobody adjudicated — every
 *        category defaults to attaching to the driver's current stop, so a
 *        `truck` breakdown reported at Ipoh would pay Ipoh.
 *      - RETRY MUST SETTLE NOTHING. "Retry" means go back and try again; the
 *        stop is still outstanding and the trip must stay open so the driver
 *        CAN deliver it. Settling on retry finalized the trip under him and
 *        left the later delivery rejected as TRIP_NOT_ACTIVE.
 *
 *    So: an explicit `verify` action is the admin's "this was a genuine failed
 *    delivery" (R1 Q2a "admin verify and approve"), and `resume` is "we are
 *    not going back for it". `reject` remains the explicit no-pay lever, and
 *    an exception still OPEN earns nothing yet.
 *
 *    ⚠ The admin UI must SAY this — Verify is a pay decision, not a filing
 *    action. See the button copy in mobile/src/admin/screens/ExceptionsScreen.
 *
 * ── THE PAY INSTANT ─────────────────────────────────────────────────────────
 * A delivered stop attributes its pay to `delivered_at` (client rule, 3 Jul:
 * points key on delivery-confirm time). An undelivered one has none, so it
 * attributes to `arrived_at` — the moment the driver was AT the stop, the
 * nearest true analogue. Deliberately NOT the admin's verify/resolve time: that
 * would let an admin's delay move a driver's pay day and rate tier.
 *
 * ⚠ OPEN QUESTION — QUESTIONS_FOR_TEH_R4.md §A1 ($UWC_REFS_DIR). Does a
 * paid-but-undelivered stop consume its zone's "first drop of the day" slot,
 * demoting a LATER real delivery to the 1-point repeat? This module says YES
 * (see stopPayInstant's callers and dayLedger): his repeat rule is phrased "if
 * he GO TO P1 … subsequent destination in same day, same zone will be 1 point",
 * and a failed attempt is still going there. But he has never been asked
 * directly, and the opposite reading (only a real delivery claims the zone) is
 * defensible — roughly RM33 per occurrence on a P1 pair. Asked, not assumed.
 */

/**
 * The DB-query form of the same rule: a stop SETTLED as paid-undelivered.
 * Structural (no Prisma import) but assignable to Prisma.TripStopWhereInput.
 *
 * ONE definition, four call sites — they must never drift apart:
 *   1. finalization: which stops are scored (routes/trips.ts);
 *   2. the cross-trip day ledger (services/dayLedger.ts);
 *   3. the completion gate — a settled stop must NOT count as outstanding, or
 *      the trip can never finalize and the pay never proposes;
 *   4. the abort branch — a trip whose stops ALL failed still earns, so the
 *      "did anything earn?" count cannot be delivered-only.
 */
export const SETTLED_UNDELIVERED_WHERE = {
  status: { not: "delivered" as const },
  arrived_at: { not: null },
  exceptions: {
    some: {
      current_state: "resolved" as const,
      resolution: "resume" as const, // NOT retry — retry leaves the stop outstanding
      actions: { some: { type: "verify" as const } }, // the admin's pay decision
    },
  },
};

/**
 * The Prisma SELECT that makes a stop's pay decidable. Every site that calls
 * stopPayInstant / firstEarningInstant on DB rows must use it — the predicate is
 * re-checked in memory, so an under-selected row looks unpaid and the stop
 * silently drops out of the bucket. One constant, so that cannot drift.
 */
export const EARNING_STOP_SELECT = {
  status: true,
  arrived_at: true,
  delivered_at: true,
  exceptions: {
    select: {
      current_state: true,
      resolution: true,
      actions: { where: { type: "verify" as const }, select: { type: true }, take: 1 },
    },
  },
} as const;

/**
 * The same three fields as an `include` fragment, for queries that INCLUDE a
 * stop's relations rather than select its columns (the trip payload, the
 * dispatch engine). Exposing them lets a CLIENT tell a settled stop from an
 * outstanding one — mobile/src/lib/stopSettled.ts mirrors the predicate.
 *
 * Both trip includes must carry it or TypeScript rejects assigning one result
 * to the other; that friction is deliberate, since a payload that omits it
 * makes every stop read as outstanding.
 */
export const SETTLED_EXCEPTION_INCLUDE = {
  select: {
    current_state: true,
    resolution: true,
    actions: { where: { type: "verify" as const }, select: { type: true }, take: 1 },
  },
} as const;

/**
 * SQL superset bound for "this trip EARNED something inside [gte, lt)" — the
 * OR of a delivered stop in the window and a settled-undelivered stop whose
 * ARRIVAL is in the window. Report queries that bounded only on `delivered_at`
 * would drop an all-failed trip from every month: its pay instant is an
 * arrival, and pickup can sit in a different month entirely.
 */
export function earnedInWindow(window: { gte: Date; lt?: Date }) {
  return {
    OR: [
      { delivered_at: window },
      { ...SETTLED_UNDELIVERED_WHERE, arrived_at: window },
    ],
  };
}

/** The minimum shape this decision needs. Structural, so tests need no Prisma. */
export interface PayableStopLike {
  status: string;
  arrived_at: Date | null;
  delivered_at: Date | null;
  /** Exceptions ATTACHED TO THIS STOP (trip_stop_id = this stop). */
  exceptions?: {
    current_state: string;
    resolution: string | null;
    /** The append-only action log — `verify` is the admin's pay decision. */
    actions?: { type: string }[];
  }[];
}

export type PayEligibility =
  | "delivered" // earns on the normal path
  | "undelivered_paid" // R3 Q11(a) — reached, couldn't deliver, admin resolved
  | "unpaid"; // earns nothing

/**
 * True when a stop-attached exception was VERIFIED by an admin and closed with
 * `resume` — the two-part adjudication. Mirrors SETTLED_UNDELIVERED_WHERE.
 */
export function hasResolvedStopException(stop: PayableStopLike): boolean {
  return (stop.exceptions ?? []).some(
    (e) =>
      e.current_state === "resolved" &&
      e.resolution === "resume" &&
      (e.actions ?? []).some((a) => a.type === "verify")
  );
}

/** Why (or whether) this stop earns. */
export function stopPayEligibility(stop: PayableStopLike): PayEligibility {
  if (stop.status === "delivered") return "delivered";
  // Never reached → his (b): no incentive for stops the driver did not get to.
  if (!stop.arrived_at) return "unpaid";
  // Reached, but nobody adjudicated it (still open) or it was rejected.
  if (!hasResolvedStopException(stop)) return "unpaid";
  return "undelivered_paid";
}

/**
 * True when this stop is SETTLED as paid-undelivered — closed and paid, with
 * nothing left for the driver to do. The "is this stop still outstanding?"
 * question, for the API's default-stop picker and for the driver app's
 * next-stop pickers (mobile/src/lib/stopSettled.ts mirrors this).
 *
 * Distinct from `stopEarns`: a DELIVERED stop earns but is not "settled
 * undelivered", and a stop with an open exception is outstanding, not settled.
 */
export function isStopSettled(stop: PayableStopLike): boolean {
  return stopPayEligibility(stop) === "undelivered_paid";
}

/** True when the stop earns at all (either path). */
export function stopEarns(stop: PayableStopLike): boolean {
  return stopPayEligibility(stop) !== "unpaid";
}

/**
 * The instant this STOP's pay attributes to — the day-group and rate-tier
 * anchor. Null when the stop earns nothing.
 *
 * Named `stopPayInstant`, NOT `payAttributionInstant`: tripCompletion.ts
 * already exports a TRIP-level `payAttributionInstant` (the month bucket), and
 * two identically-named functions imported side by side is a drift trap.
 *
 * `fallback` covers the legacy anomaly of a stop marked delivered with a NULL
 * `delivered_at` (real — surfaced by /reports/attention). The pre-existing
 * grouping treated those as "now" rather than dropping them, and dropping one
 * would silently zero a whole drop's pay. Only the delivered branch can be
 * null; an undelivered-paid stop always has an arrival by construction.
 */
export function stopPayInstant(stop: PayableStopLike, fallback?: Date): Date | null {
  switch (stopPayEligibility(stop)) {
    case "delivered":
      return stop.delivered_at ?? fallback ?? null;
    case "undelivered_paid":
      return stop.arrived_at;
    case "unpaid":
      return null;
  }
}

/**
 * Does this trip have an OPEN exception — blocking or not?
 *
 * ⚠ Use this, never `Trip.open_exception_id`, for any guard that means "an
 * unadjudicated report exists". Since the driver's Continue-trip route the
 * pointer means "an exception is BLOCKING this trip": tapping Continue clears
 * it and leaves the report open. The two are no longer the same question, and
 * confusing them cost the driver his R3-Q11(a) pay on the abort path.
 *
 * Accepts a transaction client so the caller can ask it under the trip lock.
 */
export async function hasOpenException(
  client: Pick<PrismaClient, "tripException"> | Prisma.TransactionClient,
  tripId: string
): Promise<boolean> {
  const open = await client.tripException.count({ where: { trip_id: tripId, closed_at: null } });
  return open > 0;
}
