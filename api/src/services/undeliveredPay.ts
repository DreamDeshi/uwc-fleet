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
 *    not going back for it". `reject` is the explicit no-pay lever, and an
 *    exception still OPEN earns nothing yet.
 *
 * 4. NO exception on the stop was REJECTED. A stop can carry several reports
 *    (a driver may continue past one and file another), and the office decides
 *    each separately — so one stop can hold an approval AND a rejection.
 *
 *    Owner ruling, 30 Jul 2026: the REJECTION WINS. Until then the predicate
 *    was `some` alone, so any single approval paid the stop in full and reject
 *    meant nothing whenever a second report existed — which contradicts calling
 *    it the no-pay lever three lines above. Two admin decisions cannot both be
 *    honoured; the safe tie-break is the one that withholds money, because an
 *    unpaid stop is a conversation and an overpaid one is a clawback.
 *
 *    ⚠ CONSEQUENCE, accepted deliberately: a bogus first report that an admin
 *    rejects will veto pay for a LATER genuine failure on the same stop.
 *
 *    ⚠ AND THERE IS NO WAY BACK. An earlier draft of this comment claimed the
 *    office could revisit a bad reject. It cannot. `rejected` is TERMINAL and
 *    PERMANENT: it is not an open state (services/exceptionWorkflow), the
 *    close CAS is guarded on `closed_at: null` and reject sets `closed_at` in
 *    the same update, `stateAfterEvidence` refuses further evidence, and there
 *    is no delete path. So a rejected report poisons the stop for the life of
 *    the trip, and the only remedies are the approval-screen amount edit —
 *    which requires the trip to reach `pending_approval` — or a hand-written
 *    DB update. Post-completion correction is impossible BY DESIGN
 *    (UWC_MASTER_PROJECT_DOCUMENT §22: the correction plan is a design archive,
 *    "do not build without a fresh owner decision").
 *
 *    Say this to an admin before they tap Reject, or they will discover it on
 *    a driver's payslip.
 *
 *    ⚠ Only an explicit `rejected` vetoes. A report still OPEN, or one closed
 *    as `retry`, must NOT withhold settled pay — otherwise a driver loses money
 *    by filing a second report nobody has read yet.
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
 * TWO predicates, because there are TWO questions, and answering both with one
 * constant is what made the reject veto strand trips.
 *
 *   ADJUDICATED_UNDELIVERED_WHERE — "is the driver still on the hook for this
 *     stop?" NO reject veto. Call sites: the completion gate (routes/trips.ts
 *     and the exception-close gate in routes/exceptions.ts) and the default
 *     stop picker. Mirrored client-side by lib/stopSettled.isStopAdjudicated.
 *
 *   SETTLED_UNDELIVERED_WHERE — "does this stop PAY?" Adjudicated AND no
 *     rejection. Call sites: finalization scoring (services/tripFinalize), the
 *     cross-trip day ledger (services/dayLedger — pay and the zone slot must
 *     agree or a later delivery is mis-scored), the abort branch's "did
 *     anything earn?" count, and earnedInWindow → the payroll reads.
 *     Mirrored client-side by lib/stopSettled.isStopSettled.
 *
 * SETTLED is derived from ADJUDICATED by construction, so the shared half
 * cannot drift; dayLedger's type derives from SETTLED's `exceptions` in turn.
 *
 * Structural (no Prisma import) but assignable to Prisma.TripStopWhereInput.
 */
/**
 * ADJUDICATED — the office has CLOSED this stop out: verified the failure and
 * resumed ("we are not going back for it"). It is no longer outstanding work.
 *
 * ⚠ DELIBERATELY WITHOUT THE REJECT VETO. This answers "must the driver still
 * deliver this?", which is a DIFFERENT question from "does it pay". Conflating
 * them was a bug: with the veto in the single shared predicate a
 * rejected-but-also-approved stop went back to OUTSTANDING, so a trip with a
 * DELIVERED sibling stop stopped auto-finalizing — driver and truck held by the
 * one-active guard, and the pay that sibling earned never proposed.
 *
 * A rejected stop is ADJUDICATED — the office decided. It just does not pay.
 *
 * ⚠ WHAT THIS SPLIT DOES **NOT** FIX, stated plainly because an earlier draft of
 * this comment wrongly claimed it did. On a trip where EVERY stop is vetoed,
 * `finalizeIfNothingOutstanding` finds nothing outstanding but nothing earning
 * either, so it declines (routes/exceptions.ts) and the trip sits `in_progress`
 * until an admin aborts — which lands it in `cancelled` with a null incentive
 * and therefore no `pending_approval`, so no amount-edit route. RM0 is the
 * INTENDED amount there (every stop was rejected), but the trip hanging and the
 * driver being locked out of other work by the one-active guard is a real
 * operational dead-end, and it is NEW: before the split ADJUDICATED === SETTLED,
 * so `earning === 0` with nothing outstanding was unreachable dead code.
 * Raised for a decision rather than papered over.
 *
 * Use this for outstandingness: the completion gate, the default stop picker,
 * and the client's outstanding-stops rail.
 */
export const ADJUDICATED_UNDELIVERED_WHERE = {
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

export const SETTLED_UNDELIVERED_WHERE = {
  ...ADJUDICATED_UNDELIVERED_WHERE,
  exceptions: {
    ...ADJUDICATED_UNDELIVERED_WHERE.exceptions,
    // AN EXPLICIT REJECT WINS (owner ruling, 30 Jul 2026).
    //
    // This used to be `some` alone — OR-of-adjudications — so one approval paid
    // the stop in full even where an admin had explicitly REJECTED another
    // report on it. That made `reject` mean nothing whenever a second report
    // existed, while this module's own header calls it "the explicit no-pay
    // lever". Two decisions contradicted each other and the tie broke toward
    // paying, silently.
    //
    // Reachable in the ordinary course since 20260730120000 let a driver hold
    // several open reports at once, and reachable sequentially before that.
    none: { current_state: "rejected" as const },
  },
};

/**
 * WHAT THIS STOP WAS ACTUALLY PAID FOR — the form every HISTORICAL read must
 * use: the day ledger, and the payroll/earnings window.
 *
 * ⚠ WHY NOT JUST SETTLED_UNDELIVERED_WHERE. That predicate is recomputed from
 * LIVE exception state, and since the reject veto landed it is no longer
 * MONOTONIC: a sibling report can still be OPEN when a trip finalizes (the
 * write-once CAS requires `open_exception_id: null`, not "no open exception",
 * and driver Continue clears that pointer). Reject it afterwards and the stop
 * stops matching — but the money was already written. The ledger would then stop
 * counting a stop the driver WAS paid for, so the next same-zone drop that day
 * scores 6 instead of 1 (~RM33, the double-first-drop hole dayLedger exists to
 * prevent), and firstEarningInstant can re-key the trip's payroll MONTH.
 *
 * ⚠ WHY NOT JUST `points_awarded: { not: null }` EITHER — the trap I nearly fell
 * into. Scoring happens at FINALIZATION, but LEDGER_TRIP_STATUSES includes
 * `in_progress` on purpose: two trips can overlap, and a delivered stop on a
 * still-running trip must already occupy its zone slot (the RM88→RM55 hole).
 * Those stops have no `points_awarded` yet. Keying purely on persisted evidence
 * would drop them and reopen that hole for every concurrent trip.
 *
 * So: PREFER the persisted record, FALL BACK to the live predicate. The fallback
 * serves two populations, not one — stops on in-flight trips (nothing written
 * yet, and nothing paid yet either, so there is nothing to diverge from) and
 * legacy rows finalized before the breakdown feature existed. It is the ORDINARY
 * path for a concurrent trip, not a rarely-exercised legacy branch, which is why
 * it carries DB-level tests rather than unit ones.
 */
export const SCORED_UNDELIVERED_WHERE = {
  status: { not: "delivered" as const },
  arrived_at: { not: null },
  OR: [
    // Persisted: finalization already decided this stop earned. Frozen.
    { points_awarded: { not: null } },
    // Not yet scored (in-flight) or pre-feature (legacy): ask the live rule.
    { points_awarded: null, exceptions: SETTLED_UNDELIVERED_WHERE.exceptions },
  ],
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
  // The persisted record of what this stop earned — preferred over the live
  // exception state by stopPayEligibility. Every money-bucket caller selects it.
  points_awarded: true,
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
      // SCORED, not SETTLED: payroll must reflect what was PAID, not what the
      // live exception state would pay if asked again today. A reject landing
      // after finalization must not make paid money vanish from a month's sheet.
      { ...SCORED_UNDELIVERED_WHERE, arrived_at: window },
    ],
  };
}

/** The minimum shape this decision needs. Structural, so tests need no Prisma. */
export interface PayableStopLike {
  status: string;
  arrived_at: Date | null;
  delivered_at: Date | null;
  /**
   * Points this stop was ACTUALLY scored for, written once at finalization.
   * Non-null ⇒ it earned, whatever the exceptions say now. Optional: a caller
   * that has not selected it simply falls back to the live rule, which is the
   * pre-persistence behaviour rather than a silently wrong answer.
   */
  points_awarded?: number | null;
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
  // ADJUDICATED: the office verified the failure and resumed. NO reject veto —
  // this is the outstandingness question. Twin of ADJUDICATED_UNDELIVERED_WHERE.
  return (stop.exceptions ?? []).some(
    (e) =>
      e.current_state === "resolved" &&
      e.resolution === "resume" &&
      (e.actions ?? []).some((a) => a.type === "verify")
  );
}

/**
 * An explicit rejection on this stop. Twin of SETTLED_UNDELIVERED_WHERE's
 * `none: { current_state: "rejected" }`.
 *
 * Only `rejected` counts. A report still OPEN, or one closed as `retry`, must
 * NOT withhold settled pay — otherwise a driver loses money by filing a second
 * report nobody has read yet.
 */
export function hasRejectedStopException(stop: PayableStopLike): boolean {
  return (stop.exceptions ?? []).some((e) => e.current_state === "rejected");
}

/** Why (or whether) this stop earns. */
export function stopPayEligibility(stop: PayableStopLike): PayEligibility {
  if (stop.status === "delivered") return "delivered";
  // Never reached → his (b): no incentive for stops the driver did not get to.
  if (!stop.arrived_at) return "unpaid";
  // PERSISTED WINS. Finalization already scored this stop, so it was paid — a
  // later adjudication must not retro-change that, or the ledger and the payroll
  // month disagree with money already written. Only reachable post-finalization;
  // during finalization itself points_awarded is still null and the live rule
  // below decides, which is what writes it.
  if (stop.points_awarded != null) return "undelivered_paid";
  // Reached, but nobody adjudicated it (still open, or closed as retry).
  if (!hasResolvedStopException(stop)) return "unpaid";
  // Adjudicated, but an explicit reject on the same stop vetoes the pay.
  if (hasRejectedStopException(stop)) return "unpaid";
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

/**
 * Is this stop CLOSED OUT — no longer work the driver owes? True for a settled
 * stop AND for one whose pay was vetoed by a rejection: the office decided
 * either way, so it must not hold the trip open.
 *
 * The in-memory twin of ADJUDICATED_UNDELIVERED_WHERE. Never use isStopSettled
 * for outstandingness — that is the conflation that stranded trips.
 */
export function isStopAdjudicated(stop: PayableStopLike): boolean {
  if (stop.status === "delivered") return true;
  if (!stop.arrived_at) return false;
  return hasResolvedStopException(stop);
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
