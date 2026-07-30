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
import { INTERPLANT_ROUTE_TYPES } from "../lib/uwcSpec";

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
    /** Interplant trips are excluded — see the note at the value site. */
    route_type: { name: { notIn: string[] } };
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
      // INTERPLANT TRIPS DO NOT ENTER THIS LEDGER, in either direction.
      //
      // They are paid under a separate scheme (flat 1 point per completed round
      // trip, no deduction — A4, 29 Jul 2026), so they neither consume a zone's
      // first-drop slot nor read one. Every UWC plant sits in zone P2, so
      // without this an interplant run in the morning would silently demote a
      // real afternoon delivery to Juru or Perai — also P2 — from full points to
      // the 1-point repeat, on the strength of a trip scored by a rule that has
      // nothing to do with zones.
      //
      // The converse needs no code: the interplant branch of
      // calculateDeliveryIncentive returns before it reads the ledger at all.
      route_type: { name: { notIn: [...INTERPLANT_ROUTE_TYPES] } },
    },
  };
}

// Compile-time proof the concrete shape stays a valid Prisma where input.
const _assignable: Prisma.TripStopWhereInput = {} as PriorDeliveredDropsWhere;
void _assignable;
