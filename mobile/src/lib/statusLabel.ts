// Which words each role sees for a TripStatus. Pure module (no React Native
// imports) — unit-tested in statusLabel.test.ts, following lib/tripStatus.ts.
//
// WHY THIS FILE EXISTS
// --------------------
// `pending_approval` means "delivered; the DRIVER'S INCENTIVE is awaiting an
// admin". StatusBadge rendered it as "Awaiting Approval" for every role, so a
// requestor whose goods had already arrived read their booking as still
// unapproved — the opposite of what happened, and the state they see while
// waiting for a driver ("Pending — Awaiting Admin Review") uses the same words.
//
// The rest of the app already took the requestor's side of this: `IS_DELIVERED`
// in tripStatus.ts counts `pending_approval` as delivered, `statusColors` paints
// it GREEN like `completed`, and the requestor's own booking-detail banner reads
// "Delivered". Only this badge disagreed, so one booking could read "Delivered"
// on its detail screen and "Awaiting Approval" in the list behind it.
//
// The distinction is NOT cosmetic for the other two roles — the driver's money
// is held until that approval, and the admin is the one who grants it — so this
// narrows by role rather than retiring the label.

import type { Role, TripStatus } from "../types";

/** The label every role sees unless a rule below overrides it. */
export const STATUS_LABEL_KEY: Record<TripStatus, string> = {
  pending: "trip.statusPending",
  approved: "trip.statusApproved",
  assigned: "trip.statusAssigned",
  in_progress: "trip.statusInProgress",
  pending_approval: "trip.statusPendingApproval",
  completed: "trip.statusCompleted",
  rejected: "trip.statusRejected",
  cancelled: "trip.statusCancelled",
};

/**
 * The i18n key for `status` as seen by `role`.
 *
 * Only one status reads differently, and only for one role: a requestor sees
 * `pending_approval` as "Delivered", because the pay approval it names is not
 * their business and not their booking's state. Driver and admin keep
 * "Awaiting Approval" — for them it is the whole point of the status.
 *
 * An unknown role (including a null user before /me resolves) gets the
 * unnarrowed label, which is the safe default: it never tells a requestor their
 * goods arrived when they have not.
 */
export function statusLabelKey(status: TripStatus, role: Role | null | undefined): string {
  if (role === "requestor" && status === "pending_approval") return "trip.statusDelivered";
  return STATUS_LABEL_KEY[status] ?? STATUS_LABEL_KEY.pending;
}
