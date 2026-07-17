// The single place that decides how each TripStatus is grouped for a list,
// filter or dashboard. Pure module (no React Native imports) — unit-tested in
// tripStatus.test.ts.
//
// WHY THIS FILE EXISTS
// --------------------
// `pending_approval` was added to TripStatus by the POD approval gate (item 9)
// and EVERY consumer kept compiling. Two shapes swallowed it silently:
//
//   1. `switch (status) { … default: return cancelledBanner }` — the `default:`
//      caught the new member, so a DELIVERED booking rendered a red
//      "Booking Cancelled" banner to the requestor.
//   2. `const ACTIVE: TripStatus[] = ["pending", …]` — TypeScript does NOT
//      exhaustiveness-check an array literal, so the new status was simply
//      dropped from every filter that read it.
//
// The fix for (1) is `assertNever` in place of the `default:` (see below — the
// guard only works if the catch-all is DELETED, not merely accompanied).
// The fix for (2) is this file's technique: write the decision as a
// `Record<TripStatus, boolean>`, where a missing key IS a compile error, and
// DERIVE the array from it. Adding a 9th status now fails the build here
// instead of producing a wrong answer at ~150 read sites.

import type { TripStatus } from "../types";

/**
 * Compile-time exhaustiveness guard for a `switch`/if-chain over a union.
 * Call it in the branch that must be unreachable: add a union member and
 * `value` stops being `never`, so the build fails AT that site.
 *
 * ⚠ It only works if you DELETE the catch-all (`default:` / a bare trailing
 * `return`). A guard sitting behind a catch-all is unreachable code and changes
 * nothing — the catch-all is precisely what swallows the new member.
 *
 * Throws at runtime only if a value outside the union arrives at all (e.g. an
 * older client reading a status a newer server invented).
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

/**
 * Derive a status list from an exhaustive decision map. The `Record<TripStatus,
 * boolean>` parameter is the load-bearing part: every status must be named, so
 * a new one cannot be forgotten.
 */
function statusesWhere(map: Record<TripStatus, boolean>): TripStatus[] {
  return (Object.keys(map) as TripStatus[]).filter((s) => map[s]);
}

// ── ACTIVE: the job is still in flight ──────────────────────────────────────
// Shared by the requestor's Bookings tab and the driver's Trips tab (both had
// their own identical array literal before this file; both drifted the same way
// when item 9 landed).
const IS_ACTIVE: Record<TripStatus, boolean> = {
  pending: true,
  approved: true,
  assigned: true,
  in_progress: true,
  // Delivered — the driving is done. The POD/pay gate that follows is not the
  // trip being "active"; it is money awaiting an admin. See IS_DELIVERED.
  pending_approval: false,
  completed: false,
  rejected: false,
  cancelled: false,
};

export const ACTIVE_STATUSES: TripStatus[] = statusesWhere(IS_ACTIVE);

// ── DELIVERED: the goods reached the consignee ──────────────────────────────
// `pending_approval` and `completed` differ ONLY by whether an admin has
// approved the driver's incentive yet. That distinction is real for the driver
// (his money is held) and irrelevant to the requestor (their goods arrived), so
// both statuses are "delivered" for listing purposes and the difference is
// carried by the Earnings screen's pending badge, not by the filter.
const IS_DELIVERED: Record<TripStatus, boolean> = {
  pending: false,
  approved: false,
  assigned: false,
  in_progress: false,
  pending_approval: true, // delivered; incentive proposed, not yet approved
  completed: true, // delivered; incentive approved and payable
  rejected: false,
  cancelled: false,
};

export const DELIVERED_STATUSES: TripStatus[] = statusesWhere(IS_DELIVERED);

/** True once the goods have reached the consignee, approved or not. */
export function isDelivered(status: TripStatus): boolean {
  return IS_DELIVERED[status];
}

/**
 * True while the driver's incentive is proposed but not yet approved — the
 * money exists and is visible, but is NOT payable and must never be presented
 * as paid. The server is the authority (`GET /incentives/mine` sends `pending`
 * per trip); this mirrors it for status-only callers.
 */
export function isAwaitingApproval(status: TripStatus): boolean {
  return status === "pending_approval";
}
