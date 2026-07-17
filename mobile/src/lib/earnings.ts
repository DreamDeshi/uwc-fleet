// Driver earnings arithmetic. Pure module (no React Native imports) —
// unit-tested in earnings.test.ts.
//
// WHY THIS FILE EXISTS
// --------------------
// The weekly chart used to live inside EarningsScreen and summed EVERY trip,
// while the summary card directly above it showed the server's `summary.total`,
// which EXCLUDES trips awaiting POD approval. So one screen showed two
// different totals, and the larger one counted money the driver had not been
// paid. Both numbers now derive from the same rule, stated once:
//
//   PAID = approved money only. A `pending` trip is money PROPOSED, not earned.
//
// The screen could not be unit-tested (importing it pulls in React Native), so
// the arithmetic lives here where it can be. That is not incidental: the bug it
// carried was arithmetic, and it survived precisely because nothing could
// assert on it.

import type { IncentiveTrip, TripStatus } from "../types";
import { assertNever } from "./tripStatus";

/**
 * Which money figure a trip card/row should show, and how it must be dressed.
 *
 *  - "final"    → approved and payable: the confident green RM.
 *  - "awaiting" → DELIVERED and proposed, but NOT approved: show the real amount,
 *                 muted, with a chip. Never green.
 *  - "estimate" → not delivered yet: an estimate, amber "Est." chip.
 *  - "none"     → cancelled/rejected: no amount at all.
 *
 * Classification is on STATUS ALONE, deliberately NOT on whether an amount is
 * present. The trap this closes: TripCard used `incentive_earned !== null` as
 * "this is what you were paid". But the engine writes the PROPOSAL at delivery,
 * so a pending_approval trip HAS an amount while the money is still held —
 * "amount present" and "paid" are different things. Only a `completed` trip is
 * payable, so "final" (green) is reachable ONLY from `completed`, by
 * construction. A stray amount on any other status can no longer turn it green,
 * and a 9th status fails the build here rather than defaulting into a pay state.
 */
export type TripMoneyState = "final" | "awaiting" | "estimate" | "none";

export function tripMoneyState(trip: { status: TripStatus }): TripMoneyState {
  switch (trip.status) {
    case "cancelled":
    case "rejected":
      return "none";
    case "pending_approval":
      return "awaiting"; // delivered, proposed, not yet approved — never green
    case "completed":
      return "final"; // the ONLY payable state
    case "pending":
    case "approved":
    case "assigned":
    case "in_progress":
      return "estimate"; // not delivered — an estimate, not a paid figure
    default:
      return assertNever(trip.status, "TripStatus");
  }
}

/** Monday-first weekday index (Mon = 0 … Sun = 6). */
export function mondayFirstIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Local midnight on the Monday of the week containing `now`. */
export function weekStart(now: Date): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const monday = new Date(midnight);
  monday.setDate(midnight.getDate() - mondayFirstIndex(midnight));
  return monday;
}

/**
 * The instant a trip's pay is attributed to — the delivery confirm, which is
 * what the incentive engine keys the rate tier and pay-day on. Pickup is only
 * the not-yet-delivered fallback. (Bucketing on pickup once made this chart
 * disagree with the month total for any overnight trip — the same disagreement
 * bug, a different cause.)
 */
export function payAttributionInstant(trip: IncentiveTrip): Date {
  return new Date(trip.delivered_at ?? trip.pickup_datetime);
}

/**
 * True when this trip's money is payable — i.e. an admin has approved the POD
 * and the incentive is final. The server is the authority and sends `pending`
 * per trip; `pending !== true` is deliberate rather than `=== false`, so an
 * older API build that omits the field is treated as PAID (its trips predate
 * the approval gate and were auto-paid — the grandfathered case), not as
 * pending.
 */
export function isPaid(trip: IncentiveTrip): boolean {
  return trip.pending !== true;
}

/**
 * Earnings per weekday (Mon-first) for the week containing `now`.
 *
 * PAID MONEY ONLY. Pending trips are excluded so this chart agrees with the
 * summary card above it, which uses the server's `summary.total` — and that
 * already excludes pending (`api/src/routes/incentives.ts`). One rule, both
 * places.
 */
export function weekBuckets(trips: IncentiveTrip[], now: Date): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  const monday = weekStart(now);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);

  for (const trip of trips) {
    if (!isPaid(trip)) continue; // proposed, not earned — never chart it as paid
    const at = payAttributionInstant(trip);
    if (at >= monday && at < nextMonday) {
      buckets[mondayFirstIndex(at)] += Number(trip.incentive_earned ?? 0);
    }
  }
  return buckets;
}

/**
 * Total money proposed but still awaiting admin approval. Shown to the driver
 * as its own figure: the money must not be hidden (he earned it and wants to
 * see it), but it must never be added to what he has been paid.
 */
export function pendingTotal(trips: IncentiveTrip[]): number {
  return trips
    .filter((trip) => !isPaid(trip))
    .reduce((sum, trip) => sum + Number(trip.incentive_earned ?? 0), 0);
}

/** How many trips are awaiting approval — drives the "N awaiting" caption. */
export function pendingCount(trips: IncentiveTrip[]): number {
  return trips.filter((trip) => !isPaid(trip)).length;
}
