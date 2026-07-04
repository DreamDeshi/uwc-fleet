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

/** Trip statuses whose delivered drops feed the day ledger. */
export const LEDGER_TRIP_STATUSES = ["in_progress", "completed"] as const;

// Concrete shape (rather than the wide Prisma input type) so tests can assert
// the exact semantics; structurally assignable to Prisma.TripStopWhereInput.
export interface PriorDeliveredDropsWhere {
  status: "delivered";
  delivered_at: { gte: Date; lt: Date };
  trip: {
    driver_id: string;
    status: { in: ("in_progress" | "completed")[] };
    id: { not: string };
  };
}

/**
 * Where-clause for the drops this driver delivered on `[dayStart, anchor)` on
 * trips other than the one being finalized — the "prior drops today" ledger
 * for one delivery-day group. `anchor` is the group's first delivered_at
 * (DeliveryDayGroup.anchor); `dayStart` bounds it to the group's MYT day.
 */
export function priorDeliveredDropsWhere(params: {
  driverId: string;
  excludeTripId: string;
  dayStart: Date;
  anchor: Date;
}): PriorDeliveredDropsWhere {
  return {
    status: "delivered",
    delivered_at: { gte: params.dayStart, lt: params.anchor },
    trip: {
      driver_id: params.driverId,
      status: { in: [...LEDGER_TRIP_STATUSES] },
      id: { not: params.excludeTripId },
    },
  };
}

// Compile-time proof the concrete shape stays a valid Prisma where input.
const _assignable: Prisma.TripStopWhereInput = {} as PriorDeliveredDropsWhere;
void _assignable;
