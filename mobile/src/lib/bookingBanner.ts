// The requestor's booking-detail status banner: which colour, icon and label a
// trip status gets. Pure module (no React Native imports) — unit-tested in
// bookingBanner.test.ts, which is the point of it living here rather than
// inside BookingDetailScreen: the screen cannot be imported by a test (it pulls
// in React Native), so a switch inside it was untestable and drifted unnoticed.
//
// It drifted exactly once, expensively: `pending_approval` (added by the POD
// approval gate, item 9) hit the old `default:` branch and rendered a red
// "Booking Cancelled" banner on a booking that had been successfully DELIVERED.
// There is no `default:` here now — see the assertNever call.

import { colors } from "../theme";
import { assertNever } from "./tripStatus";
import type { TripStatus } from "../types";

/**
 * The Ionicons names this banner can use. Spelled as a literal union rather
 * than `keyof typeof Ionicons.glyphMap` so the module stays free of the
 * @expo/vector-icons import and remains unit-testable; the union members are
 * still checked against Ionicons' prop type at the call site.
 */
export type BannerIcon =
  | "time-outline"
  | "checkmark-circle"
  | "navigate"
  | "checkmark-done"
  | "close-circle";

export interface Banner {
  bg: string;
  fg: string;
  icon: BannerIcon;
  /** i18n key under `bookingDetail.*` — the caller runs it through `t()`. */
  textKey: string;
}

/**
 * The banner a requestor sees for a booking in `status`.
 *
 * REQUESTOR SEMANTICS: the POD approval gate is an INTERNAL pay step between
 * the driver and an admin. The requestor has no stake in it and cannot act on
 * it, so `pending_approval` deliberately reads exactly like `completed` here —
 * "Delivered". Surfacing it to the customer would raise a question they cannot
 * answer about a process that does not concern them.
 */
export function bannerFor(status: TripStatus): Banner {
  switch (status) {
    case "pending":
    case "approved":
      return { bg: colors.yellow, fg: colors.navy, icon: "time-outline", textKey: "bookingDetail.bannerPending" };
    case "assigned":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-circle", textKey: "bookingDetail.bannerAccepted" };
    case "in_progress":
      return { bg: colors.blue, fg: colors.white, icon: "navigate", textKey: "bookingDetail.bannerInProgress" };
    // The goods arrived. `pending_approval` differs from `completed` only in
    // that an admin has not yet approved the DRIVER's incentive — invisible to,
    // and irrelevant for, the requestor.
    case "pending_approval":
    case "completed":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-done", textKey: "bookingDetail.bannerCompleted" };
    case "rejected":
      return { bg: colors.red, fg: colors.white, icon: "close-circle", textKey: "bookingDetail.bannerRejected" };
    case "cancelled":
      return { bg: colors.red, fg: colors.white, icon: "close-circle", textKey: "bookingDetail.bannerCancelled" };
    default:
      // NOT a catch-all. `cancelled` is spelled out above precisely so that this
      // branch is unreachable: `status` narrows to `never` here, so adding a 9th
      // TripStatus fails THIS build instead of silently painting the new status
      // red and calling it cancelled — which is the bug that shipped last time.
      return assertNever(status, "TripStatus");
  }
}
