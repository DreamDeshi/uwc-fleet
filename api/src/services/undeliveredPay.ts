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
 * 3. A stop-attached exception CLOSED as `resolved`. That is the admin's
 *    adjudication ("admin verify and approve", R1 Q2a). `rejected` is the
 *    explicit no-pay lever and is the ONLY way an admin denies it; an exception
 *    still OPEN earns nothing yet (the trip cannot finalize while one is open).
 *
 * ── THE PAY INSTANT ─────────────────────────────────────────────────────────
 * A delivered stop attributes its pay to `delivered_at` (client rule, 3 Jul:
 * points key on delivery-confirm time). An undelivered one has none, so it
 * attributes to `arrived_at` — the moment the driver was AT the stop, the
 * nearest true analogue. Deliberately NOT the admin's verify/resolve time: that
 * would let an admin's delay move a driver's pay day and rate tier.
 *
 * ⚠ OPEN QUESTION, on the R4 list — does a paid-but-undelivered stop consume
 * its zone's "first drop of the day" slot, demoting a LATER real delivery to
 * the 1-point repeat? This module says YES (see payAttributionInstant's callers
 * and dayLedger): his repeat rule is phrased "if he GO TO P1 … subsequent
 * destination in same day, same zone will be 1 point", and a failed attempt is
 * still going there. But he has never been asked directly, and the opposite
 * reading (only a real delivery claims the zone) is defensible. Flagged rather
 * than silently assumed.
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
  exceptions: { some: { current_state: "resolved" as const } },
};

/** The minimum shape this decision needs. Structural, so tests need no Prisma. */
export interface PayableStopLike {
  status: string;
  arrived_at: Date | null;
  delivered_at: Date | null;
  /** Exceptions ATTACHED TO THIS STOP (trip_stop_id = this stop). */
  exceptions?: { current_state: string }[];
}

export type PayEligibility =
  | "delivered" // earns on the normal path
  | "undelivered_paid" // R3 Q11(a) — reached, couldn't deliver, admin resolved
  | "unpaid"; // earns nothing

/** True when a stop-attached exception was adjudicated in the driver's favour. */
export function hasResolvedStopException(stop: PayableStopLike): boolean {
  return (stop.exceptions ?? []).some((e) => e.current_state === "resolved");
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

/** True when the stop earns at all (either path). */
export function stopEarns(stop: PayableStopLike): boolean {
  return stopPayEligibility(stop) !== "unpaid";
}

/**
 * The instant this stop's pay attributes to — the day-group and rate-tier
 * anchor. Null when the stop earns nothing.
 */
export function payAttributionInstant(stop: PayableStopLike): Date | null {
  switch (stopPayEligibility(stop)) {
    case "delivered":
      return stop.delivered_at;
    case "undelivered_paid":
      return stop.arrived_at;
    case "unpaid":
      return null;
  }
}
