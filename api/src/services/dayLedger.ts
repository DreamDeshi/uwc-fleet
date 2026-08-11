/**
 * The finalize day-ledger query — MONEY PATH.
 *
 * When a trip finalizes, each of its delivery-day groups is scored against a
 * ledger of the drops this driver already delivered earlier that MYT day on
 * OTHER trips: a zone already on the ledger scores 1 point (repeat), and the
 * once-per-day deduction lands only when the ledger is empty (this trip holds
 * the day's first drop). This module owns WHICH drops feed that ledger, so
 * the two properties the money depends on are pinned by unit tests:
 *
 *  1. STATUSES — drops from `in_progress` trips count, not only `completed`
 *     ones. With completed-only, two overlapping trips to the same zone each
 *     saw an empty ledger: both paid full zone points AND both took the daily
 *     deduction (e.g. two Ipoh trips on PLX 2406 → RM44 + RM44 = RM88 where
 *     the rule says RM44 + RM11 = RM55). A delivered drop is a physical fact
 *     regardless of whether its trip has finalized yet — and an in_progress
 *     trip can never un-deliver (cancel/unassign are pending/approved/assigned
 *     only), so counting it is always safe.
 *
 *  2. ORDERING — only drops delivered STRICTLY BEFORE this group's first
 *     confirm (`delivered_at < anchor`) count. "Earlier today" must mean
 *     earlier in delivery time, not merely the same day: without the bound,
 *     counting in_progress siblings would let a finalization see drops
 *     delivered AFTER its own — demoting the true first drop to a repeat and
 *     paying nobody the full points (RM22 for the pair above). With it, the
 *     first-delivered drop always scores full + deduction and later drops
 *     score against everything delivered before them, deterministically, even
 *     when the finalizations themselves run concurrently. For serial trips
 *     (the normal one-active flow) this is identical to the old whole-day
 *     window: a previously completed trip's drops always precede this one's.
 *
 * The confirmed incentive RULE (first drop in zone full, same-zone repeat
 * 1 pt, deduction once/day, delivery-day attribution) is untouched — this is
 * purely about which drops the rule gets to see.
 */

import type { Prisma } from "@prisma/client";
// Type-only: the ledger's undelivered branch DERIVES its exception filter from
// the finalizer's constant so the two cannot describe different stops. Adding
// the reject veto to one and not the other is exactly the drift this prevents.
import { SCORED_UNDELIVERED_WHERE } from "./undeliveredPay";

// Trip statuses whose delivered drops feed the day ledger. `pending_approval`
// is included (16 Jul 2026): a trip whose last stop is delivered but whose
// incentive is awaiting admin approval still HAS those drops on the road — the
// same "a delivered drop is a physical fact regardless of whether its trip has
// finalized yet" argument as in_progress. It can't un-deliver either (approval
// only sets the pay amount; it never reverses a delivery), so counting it keeps
// the per-zone-per-day ledger correct for the driver's later trips that day.
export const LEDGER_TRIP_STATUSES = ["in_progress", "pending_approval", "completed"] as const;

// Concrete shape (rather than the wide Prisma input type) so tests can assert
// the exact semantics; structurally assignable to Prisma.TripStopWhereInput.
//
// The OR is the 29 Jul 2026 addition: a stop the driver REACHED but could not
// deliver, whose stop-attached exception an admin VERIFIED and closed with
// `resume`, now earns (R3 Q11(a), services/undeliveredPay.ts) — so it must also
// occupy its zone's slot in this ledger, or the same zone could pay full points
// twice in a day. It is bounded on `arrived_at` because that is the instant its
// pay attributes to; a stop with no arrival is his Q11(b) case and never
// appears here.
//
// ⚠ The second branch MUST stay character-for-character the same predicate as
// SETTLED_UNDELIVERED_WHERE. If this ledger counted a stop the finalizer does
// not pay (or vice versa), a zone slot would be consumed by a stop that earned
// nothing — the exact shape of the old proposal-vs-paid bug. In particular
// `resolution: "resume"` and the `verify` action are both load-bearing:
// dropping either would let a bare "Resume trip" (no adjudication) demote a
// later real delivery in that zone to a 1-point repeat.
//
// ⚠ R4 QUESTION §A1: whether a failed attempt should claim the zone's
// first-drop slot at all is an inference from "if he GO TO P1 … subsequent
// destination in same day, same zone will be 1 point" — he has never been asked
// directly. Written up in QUESTIONS_FOR_TEH_R4.md ($UWC_REFS_DIR), with the
// worked RM figures and what reversing it means: delete this OR branch.
export interface PriorDeliveredDropsWhere {
  OR: [
    {
      status: "delivered";
      delivered_at: { gte: Date; lt: Date };
    },
    {
      status: { not: "delivered" };
      arrived_at: { gte: Date; lt: Date };
      // DERIVED from the finalizer's constant, not re-typed. Spelling the shape
      // out a second time is how the reject veto came to be added in one place
      // and not the other; now the type itself refuses the drift, and the value
      // below still has to match because tests/dayLedger.ts compares them.
      OR: (typeof SCORED_UNDELIVERED_WHERE)["OR"];
    },
  ];
  trip: {
    driver_id: string;
    status: { in: ("in_progress" | "pending_approval" | "completed")[] };
    id: { not: string };
    // THE POOL SPLIT — see the long note on `pool` below. Interplant work and
    // customer/supplier work keep SEPARATE day ledgers.
    route_type_id: { in: string[] } | { notIn: string[] };
  };
}

/**
 * Where-clause for the drops this driver EARNED on `[dayStart, anchor)` on
 * trips other than the one being finalized — the "prior drops today" ledger
 * for one delivery-day group. `anchor` is the group's first pay instant
 * (DeliveryDayGroup.anchor); `dayStart` bounds it to the group's MYT day.
 */
export function priorDeliveredDropsWhere(params: {
  driverId: string;
  excludeTripId: string;
  dayStart: Date;
  anchor: Date;
  /**
   * RouteType ids that are INTERPLANT work (the seeded Inter-Plant Delivery and
   * Inter-Plant Return). Resolved by the caller through isInterplantRouteType
   * so the id set and the rate branch in truckRateSnapshot are decided by ONE
   * predicate — an interplant trip cannot be paid the interplant rate but
   * scored on the customer ledger, or the reverse.
   */
  interplantRouteTypeIds: string[];
  /**
   * Which ledger the trip being finalized reads. THE TWO POOLS ARE SEPARATE.
   *
   * ── Why (owner ruling, 11 Aug 2026) ──────────────────────────────────────
   * The workbook gives interplant its own table, its own zone, its own scoring
   * and NO deduction column. Nothing folds it into the customer ledger, and
   * Mr. Teh has never described a mixed day.
   *
   * ── What a SHARED pool actually did (this is not hypothetical) ───────────
   * Two failures, both silent:
   *
   *  1. THE DEDUCTION. calculateDeliveryIncentive telescopes the deduction over
   *     the day total — max(prior+group−ded,0) − max(prior−ded,0) — which spends
   *     it exactly once per day ONLY IF every trip that day carries the same
   *     deduction. Interplant snapshots 0 (Mr. Teh: "Interplant no need
   *     deduction"), so a shared pool let a morning interplant leg pre-load
   *     `prior` and swallow the customer side's deduction whole: one P2
   *     interplant point then an Ipoh run paid max(1+6−2,0) − max(1−2,0) = 5
   *     points = RM55, where the rule says 4 points = RM44. OVERPAY, and BL9
   *     means it can never be corrected after approval.
   *
   *  2. THE ZONE SLOT. Interplant delivers to Batu Kawan, which lives in zone
   *     P2 — relabelled "Juru & Perai & batu kawan" in the 28 Jul revision. A
   *     shared pool let a morning interplant leg consume P2's first-drop slot,
   *     so an afternoon CUSTOMER delivery to Juru scored as a repeat.
   *
   * ── The cost of the ruling, stated plainly ───────────────────────────────
   * Separate pools mean a driver CAN earn a full first drop on BOTH sides in
   * one day. That is the generous direction, and like everything else on this
   * path it is not correctable once approved. It is on the first-payroll watch
   * list beside the deduction item: pull a driver with interplant AND customer
   * work on the same day and read both halves.
   */
  pool: "interplant" | "customer";
}): PriorDeliveredDropsWhere {
  const window = { gte: params.dayStart, lt: params.anchor };
  return {
    OR: [
      { status: "delivered", delivered_at: window },
      // Same predicate as SETTLED_UNDELIVERED_WHERE (services/undeliveredPay),
      // with its arrival bounded to this group's window — spelled out here
      // because the concrete shape is what the pinned tests assert.
      //
      // ⚠ THIS IS A HAND COPY, not a reuse, so it can drift from the constant.
      // It just did: adding the reject veto to undeliveredPay left this one
      // behind, and tests/dayLedger.ts caught it. That drift would have paid a
      // rejected stop NOTHING while still letting it consume its zone's
      // first-drop slot — demoting a real later delivery to a 1-point repeat on
      // the strength of a stop nobody was paid for.
      {
        status: { not: "delivered" },
        arrived_at: window,
        // SCORED, not SETTLED — see the long note on SCORED_UNDELIVERED_WHERE.
        // The ledger asks a HISTORICAL question ("what did this driver already
        // earn today"), so it must read what was PAID, not what the live
        // exception state would pay if asked again now. Otherwise a reject
        // landing after a stop was paid removes it from the ledger and the next
        // same-zone drop scores 6 instead of 1 — the double-first-drop hole
        // this file exists to prevent, reopened from the other end.
        //
        // The `points_awarded: null` fallback is NOT just for legacy rows: this
        // ledger deliberately spans `in_progress` trips (overlapping trips, the
        // RM88→RM55 case below), whose stops are not scored yet.
        OR: SCORED_UNDELIVERED_WHERE.OR,
      },
    ],
    trip: {
      driver_id: params.driverId,
      status: { in: [...LEDGER_TRIP_STATUSES] },
      id: { not: params.excludeTripId },
      // An interplant finalize sees only interplant trips; a customer finalize
      // sees everything that is NOT interplant. With no interplant route types
      // seeded, `notIn: []` matches every trip — i.e. exactly the single-pool
      // behaviour that was correct before interplant pay existed.
      route_type_id:
        params.pool === "interplant"
          ? { in: params.interplantRouteTypeIds }
          : { notIn: params.interplantRouteTypeIds },
    },
  };
}

// Compile-time proof the concrete shape stays a valid Prisma where input.
const _assignable: Prisma.TripStopWhereInput = {} as PriorDeliveredDropsWhere;
void _assignable;
