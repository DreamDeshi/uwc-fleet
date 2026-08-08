import type { TripStatus } from "../types";

/**
 * The requestor booking-detail header, as one table (design frame 9b).
 *
 * The design lists eight rows. Seven map straight onto a `TripStatus`; the
 * eighth, "Arrived", is NOT a trip status in this system — arrival is recorded
 * per STOP (`stop.arrived_at`), because a multi-stop trip arrives many times.
 * It is derived here rather than invented as a status, so nothing about the
 * server's state machine changes.
 *
 * Going the other way, the design has no row for `pending_approval` — delivered,
 * incentive proposed, awaiting the admin's POD approval. To the requestor the
 * goods HAVE arrived, so it is treated as stage 4 and offered the delivered
 * actions; the outstanding step is an internal pay approval they have no part
 * in. That matches how `statusColors` already paints it (green, same as
 * completed).
 */

/** The four labelled ticks on the progress bar. */
export const BOOKING_STAGES = ["requested", "assigned", "enRoute", "delivered"] as const;
export type BookingStage = 1 | 2 | 3 | 4;

export interface StopArrivalState {
  status?: string;
  arrived_at?: string | null;
}

/**
 * How far along the bar is filled — or null for a booking that never travelled,
 * where a 4-stage bar would imply progress that will never happen (the design
 * shows no bar for Cancelled and Rejected).
 */
export function bookingStage(status: TripStatus): BookingStage | null {
  switch (status) {
    case "pending":
    case "approved":
      return 1;
    case "assigned":
      return 2;
    case "in_progress":
      return 3;
    case "pending_approval":
    case "completed":
      return 4;
    case "cancelled":
    case "rejected":
      return null;
  }
}

/**
 * Has the truck reached a stop that it has not yet delivered?
 *
 * Only meaningful in transit: once a trip is delivered every stop has an
 * `arrived_at`, so testing arrival alone would label a finished trip "Arrived".
 */
export function isArrivedAtStop(status: TripStatus, stops: StopArrivalState[] = []): boolean {
  if (status !== "in_progress") return false;
  return stops.some((s) => Boolean(s.arrived_at) && s.status !== "delivered");
}

/** i18n key for the status pill, including the derived Arrived case. */
export function bookingStatusKey(status: TripStatus, stops: StopArrivalState[] = []): string {
  if (isArrivedAtStop(status, stops)) return "bookingDetail.stateArrived";
  return `bookingDetail.state_${status}`;
}

export type BookingAction =
  | "edit"
  | "requestChange"
  | "cancel"
  | "call"
  | "share"
  | "rebook"
  | "viewPod"
  | "seeReason";

export interface BookingActionContext {
  /** Only offer "Call Driver" when there is a number to dial. */
  hasDriverPhone: boolean;
  /** Only offer "View POD" when a photo actually exists to view. */
  hasPod: boolean;
  /** FEATURE_CHANGE_REQUESTS — the A19 approval lane. Dark in production today. */
  changeRequestsEnabled: boolean;
}

/**
 * Which bottom-bar actions a status offers, most important first.
 *
 * Two deliberate departures from frame 9b:
 *
 *  - ASSIGNED keeps Share Tracking (and Request Change behind its flag). The
 *    frame lists only "Cancel Booking"; dropping a working action to match a
 *    drawing would be a regression, and the requestor can already share from
 *    the moment a lorry is on the booking.
 *  - REJECTED's "See Reason" is offered whenever the booking is rejected, not
 *    gated on the reason being present. The frame flags this as an open item
 *    with "no confirmed reason data source yet" — that is out of date: the
 *    admin's rejection writes `trip.rejection_reason`, and the detail screen
 *    has rendered it (with an explicit "no reason given" fallback) since the
 *    POD-approval work. The data source exists.
 */
export function bookingActions(status: TripStatus, ctx: BookingActionContext): BookingAction[] {
  switch (status) {
    case "pending":
      return ["edit", "cancel"];
    case "approved":
      return ["cancel"];
    case "assigned":
      return [
        ...(ctx.changeRequestsEnabled ? (["requestChange"] as BookingAction[]) : []),
        "share",
        "cancel",
      ];
    case "in_progress":
      return [...(ctx.hasDriverPhone ? (["call"] as BookingAction[]) : []), "share"];
    case "pending_approval":
    case "completed":
      return [...(ctx.hasPod ? (["viewPod"] as BookingAction[]) : []), "rebook"];
    case "cancelled":
      return ["rebook"];
    case "rejected":
      return ["seeReason", "rebook"];
  }
}
