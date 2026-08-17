import type { Trip } from "../types";
import { ACTIVE_STATUSES, isDelivered } from "./tripStatus";
import { sameMytDay } from "./mytDay";

/**
 * What the requestor's Home screen is showing (design frame 10), computed
 * once and purely so the decision is unit-tested instead of tangled in JSX.
 *
 * The frame is built around a single "Next Booking" hero, so the whole screen
 * turns on one question — WHICH booking is next? — plus the two counts in the
 * header and a short activity list. Frame 10b is the same screen with
 * `hasEverBooked` false.
 */

export interface RequestorHome {
  /** The booking the hero card renders, or null for the empty state. */
  next: Trip | null;
  /** Bookings with a pickup on today's calendar date, any status. */
  todayCount: number;
  /** Bookings whose pickup falls in the current calendar month. */
  monthCount: number;
  /** Most recent delivered/cancelled/rejected bookings, newest first. */
  recent: Trip[];
  /** False only for a requestor with no bookings at all — frame 10b. */
  hasEverBooked: boolean;
}

function pickupTime(trip: Trip): number {
  return +new Date(trip.pickup_datetime);
}

/**
 * The MYT calendar day, not the device's — see lib/mytDay. The requestor is the
 * likeliest of the three roles to be on a DESKTOP, which is exactly where the
 * device clock and the server's day part company.
 */
const sameDay = sameMytDay;

/**
 * The one booking the hero shows.
 *
 * A trip already ON THE ROAD outranks a sooner-scheduled one, because that is
 * the booking whose truck the requestor might need to call. Otherwise it is the
 * earliest active pickup — including one already in the past, since a booking
 * whose pickup slipped is exactly the one still worth surfacing rather than
 * hiding behind a "no upcoming bookings" state.
 */
export function nextBooking(trips: Trip[], _now: Date = new Date()): Trip | null {
  const active = trips.filter((tr) => ACTIVE_STATUSES.includes(tr.status));
  if (active.length === 0) return null;
  const running = active
    .filter((tr) => tr.status === "in_progress")
    .sort((a, b) => pickupTime(a) - pickupTime(b));
  if (running.length > 0) return running[0];
  return active.slice().sort((a, b) => pickupTime(a) - pickupTime(b))[0];
}

export function requestorHome(trips: Trip[], now: Date = new Date(), recentLimit = 4): RequestorHome {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const recent = trips
    .filter((tr) => isDelivered(tr.status) || tr.status === "cancelled" || tr.status === "rejected")
    .slice()
    .sort((a, b) => pickupTime(b) - pickupTime(a))
    .slice(0, recentLimit);

  return {
    next: nextBooking(trips, now),
    todayCount: trips.filter((tr) => sameDay(new Date(tr.pickup_datetime), now)).length,
    monthCount: trips.filter((tr) => {
      const t = pickupTime(tr);
      return t >= +monthStart && t < +monthEnd;
    }).length,
    recent,
    hasEverBooked: trips.length > 0,
  };
}

/**
 * The one-line status strip under the greeting ("Truck assigned · pickup in 2
 * hours"). Returns the i18n key plus its interpolation, or null when there is
 * nothing worth a strip — a pending booking has no news yet, and saying so
 * would fill the slot with noise.
 */
export function homeStatusStrip(
  trip: Trip | null,
  now: Date = new Date()
): { key: string; hours?: number; minutes?: number } | null {
  if (!trip) return null;
  if (trip.status === "in_progress") return { key: "requestor.stripOnTheWay" };
  if (trip.status !== "assigned") return null;
  const mins = Math.round((pickupTime(trip) - +now) / 60_000);
  if (mins < 0) return { key: "requestor.stripAssigned" };
  if (mins < 60) return { key: "requestor.stripAssignedMinutes", minutes: mins };
  const hours = Math.round(mins / 60);
  if (hours > 48) return { key: "requestor.stripAssigned" };
  return { key: "requestor.stripAssignedHours", hours };
}
