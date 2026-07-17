import type { TripStatus } from "@prisma/client";
import { assertNever } from "./exhaustive";

/**
 * FR-RS2 status_breakdown — the requestor's trips counted by status.
 *
 * Five buckets, not eight: `approved` folds into `pending`, `rejected` into
 * `cancelled`, and `pending_approval` into `completed`, mirroring the requestor
 * app's own grouping.
 *
 * THE SUM CONTRACT: these five ALWAYS add up to the requestor's total trips.
 * That is load-bearing rather than cosmetic — the client derives its own total
 * by summing these five (mobile AnalyticsScreen), so a status that lands in no
 * bucket does not merely go uncounted, it shrinks the denominator. When item 9
 * added `pending_approval` and this switch had no arm for it, a requestor whose
 * only trips awaited approval saw the "No data yet" empty state despite having
 * trips — and the contract, documented in a comment one line away, was false.
 *
 * Pure module — unit-tested in tests/statusBreakdown.test.ts. It lives here
 * rather than inline in routes/analytics.ts precisely so it CAN be tested: the
 * route had no test of any kind, which is how the contract broke unnoticed.
 */
export interface StatusBreakdown {
  completed: number;
  pending: number;
  assigned: number;
  in_progress: number;
  cancelled: number;
}

export function statusBreakdown(statuses: TripStatus[]): StatusBreakdown {
  const breakdown: StatusBreakdown = {
    completed: 0,
    pending: 0,
    assigned: 0,
    in_progress: 0,
    cancelled: 0,
  };

  for (const status of statuses) {
    switch (status) {
      // The goods were DELIVERED. What is outstanding on a `pending_approval`
      // trip is an admin approving the DRIVER's incentive — an internal pay step
      // the requestor has no stake in and cannot act on, so it reads as
      // completed here exactly as it does in their booking list and banner.
      case "pending_approval":
      case "completed":
        breakdown.completed += 1;
        break;
      case "assigned":
        breakdown.assigned += 1;
        break;
      case "in_progress":
        breakdown.in_progress += 1;
        break;
      case "pending":
      case "approved":
        breakdown.pending += 1;
        break;
      case "cancelled":
      case "rejected":
        breakdown.cancelled += 1;
        break;
      default:
        // NOT a catch-all — every status is spelled out above, so `status`
        // narrows to `never` here and a 9th TripStatus fails the BUILD. Without
        // this, a new status silently falls through the switch and quietly
        // breaks the sum contract, which is precisely what happened last time.
        return assertNever(status, "TripStatus");
    }
  }

  return breakdown;
}

/** The denominator the client computes by summing the buckets. */
export function breakdownTotal(breakdown: StatusBreakdown): number {
  return (
    breakdown.completed +
    breakdown.pending +
    breakdown.assigned +
    breakdown.in_progress +
    breakdown.cancelled
  );
}
