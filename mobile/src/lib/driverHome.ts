// What the driver's Home screen is showing TODAY — pure, so the decision is
// unit-tested instead of tangled in JSX.
//
// The approved design (driver screens, 29 Jul 2026) gives Home five shapes, and
// every one of them is a statement about the day rather than a list of cards:
//
//   no_trips  — nothing assigned today
//   before    — a trip is waiting, nothing has run yet          ("FIRST TRIP")
//   running   — a trip is in progress                           ("ACTIVE TRIP")
//   between   — something was delivered, something is still due ("NEXT TRIP")
//   finished  — everything assigned today has been delivered
//
// Deliberately NOT here: money. The design puts every RM figure on My Stats
// (and Trip Details, where a driver checks why he was paid) — Home carries the
// work only, so nothing on it can be mistaken for approved pay.

import type { Trip, TripStop } from "../types";
import { isDelivered } from "./tripStatus";

export type DriverDayState = "no_trips" | "before" | "running" | "between" | "finished";

export interface DriverDay {
  state: DriverDayState;
  /** The trip the big card renders: the running one, else today's next assigned. */
  primary: Trip | null;
  /** Today's remaining assigned trips AFTER the primary, earliest pickup first. */
  upcoming: Trip[];
  /** Today's delivered trips, most recent first — the receipts. */
  receipts: Trip[];
  /** Earliest assigned trip on a LATER day. Only set when today is empty. */
  nextLater: Trip | null;
  /** Trips that make up today's workload (assigned + running + delivered). */
  tripCount: number;
  /** Stops across those trips. */
  stopCount: number;
  /** How many of those stops are delivered. */
  deliveredStops: number;
}

/**
 * Local calendar day, matching every other date comparison in the driver app.
 * The phones run on MYT; using the device day keeps "today" the same day the
 * driver's own clock shows, and keeps this function free of a timezone
 * dependency the tests would have to fake.
 */
function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function stopsOf(trip: Trip): TripStop[] {
  return [...(trip.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
}

/** Delivered / total for one trip. */
export function stopProgress(trip: Trip): { delivered: number; total: number } {
  const stops = stopsOf(trip);
  return { delivered: stops.filter((s) => s.status === "delivered").length, total: stops.length };
}

/**
 * The stop the driver is on, 1-based, for "stop 2 of 5". Counts the first
 * undelivered stop rather than `delivered + 1` so a trip whose stops were
 * finished out of order (the order is only a suggestion — Mr. Teh, 28 Jul 2026)
 * still points at real remaining work. Returns `total` once all are delivered.
 */
export function currentStopNumber(trip: Trip): number {
  const stops = stopsOf(trip);
  const idx = stops.findIndex((s) => s.status !== "delivered");
  return idx === -1 ? stops.length : idx + 1;
}

export function buildDriverDay(trips: Trip[] | undefined, now: Date): DriverDay {
  const list = trips ?? [];
  const byPickupAsc = (a: Trip, b: Trip) =>
    +new Date(a.pickup_datetime) - +new Date(b.pickup_datetime);

  // A run that started yesterday and is still open is STILL the running trip —
  // scoping this to today's pickup date would blank the driver's Home mid-run
  // just after midnight.
  const running = list.find((tr) => tr.status === "in_progress") ?? null;

  const assignedToday = list
    .filter((tr) => tr.status === "assigned" && sameDay(new Date(tr.pickup_datetime), now))
    .sort(byPickupAsc);

  const receipts = list
    .filter((tr) => isDelivered(tr.status) && sameDay(new Date(tr.pickup_datetime), now))
    .sort((a, b) => -byPickupAsc(a, b));

  // Only consulted when today is empty, so the driver still learns when he is
  // next out instead of reading "no trips" as "no work this week".
  const nextLater =
    list
      .filter((tr) => tr.status === "assigned" && +new Date(tr.pickup_datetime) > +now)
      .filter((tr) => !sameDay(new Date(tr.pickup_datetime), now))
      .sort(byPickupAsc)[0] ?? null;

  const primary = running ?? assignedToday[0] ?? null;
  const upcoming = assignedToday.filter((tr) => tr.id !== primary?.id);

  const todaysTrips = [
    ...(running ? [running] : []),
    ...assignedToday.filter((tr) => tr.id !== running?.id),
    ...receipts.filter((tr) => tr.id !== running?.id),
  ];
  const allStops = todaysTrips.flatMap(stopsOf);

  const state: DriverDayState = running
    ? "running"
    : assignedToday.length > 0
      ? receipts.length > 0
        ? "between"
        : "before"
      : receipts.length > 0
        ? "finished"
        : "no_trips";

  return {
    state,
    primary,
    upcoming,
    receipts,
    nextLater: state === "no_trips" ? nextLater : null,
    tripCount: todaysTrips.length,
    stopCount: allStops.length,
    deliveredStops: allStops.filter((s) => s.status === "delivered").length,
  };
}
