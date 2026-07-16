/**
 * The daily 3am stale-ticket auto-cancel (feedback item 8 / DG-T1).
 *
 * Mr. Teh, 16 Jul 2026: "If the ticket and request is not being delivered after
 * daily 3am, it will automatically cancel and the driver capacity will be
 * refresh." So each morning at 03:00 MYT, any ticket that never got delivered
 * from a PRIOR day is auto-cancelled, clearing the board and freeing the drivers
 * and trucks it was holding for the new day.
 *
 * SCOPE (owner-confirmed 16 Jul 2026):
 *  - Cancels only NOT-yet-started tickets: `pending`, `approved`, `assigned`.
 *    An `in_progress` trip (a driver actively out) is NEVER auto-cancelled by
 *    the clock — that is the admin's deliberate "Abort trip" lever. `delivered`
 *    work (`pending_approval`, `completed`) is finished and never touched.
 *  - "Stale" = pickup_datetime BEFORE today 00:00 MYT (yesterday or earlier).
 *    A booking scheduled for later today is upcoming work, not a leftover, so it
 *    survives the 3am run.
 *
 * Capacity "refreshes" for free: current_load is computed date-scoped from
 * assigned/in_progress trips (the item-7 fix), and the one-active-trip guard
 * keys on assigned/in_progress — so flipping a stale trip to `cancelled` drops
 * it out of every occupancy and candidate query with no manual bookkeeping.
 *
 * MONEY: cancelled tickets never delivered, so they carry no incentive — the
 * pay path is untouched (same as any other cancel). The midnight points ledger
 * (DAILY_RESET_HOUR=0) has already rolled over by 3am, so cancelling yesterday's
 * leftovers can't affect today's fresh scoring.
 */

import { prisma } from "../lib/prisma";
import { mytDayStart } from "../lib/myt";
import { recordTripEvent } from "../lib/tripHistory";
import { sendPushNotifications } from "../lib/pushNotifications";

// Not-yet-started statuses the 3am sweep may cancel. in_progress is deliberately
// excluded (see the file header): auto-aborting active work is the admin's call.
export const STALE_CANCELLABLE_STATUSES = ["pending", "approved", "assigned"] as const;

const AUTO_CANCEL_NOTE = "Auto-cancelled at 3am — undelivered past its pickup day (capacity freed for the new day)";

/**
 * Where-clause for tickets the 3am sweep cancels: a not-yet-started status whose
 * pickup was before the given MYT day-start. Pure/exported so the exact scope is
 * pinned by a unit test and can't drift (e.g. accidentally include in_progress).
 */
export function staleTicketWhere(dayStart: Date) {
  return {
    status: { in: [...STALE_CANCELLABLE_STATUSES] },
    pickup_datetime: { lt: dayStart },
  };
}

/**
 * Cancel every stale undelivered ticket as of `now` (defaults to the wall clock;
 * injectable for tests). Each cancel is a status-guarded CAS inside its own
 * transaction: if a driver started or delivered the trip in the meantime, the
 * guard misses and the trip is left alone. Returns how many were cancelled.
 */
export async function sweepStaleTickets(now: Date = new Date()): Promise<number> {
  const dayStart = mytDayStart(now);

  const stale = await prisma.trip.findMany({
    where: staleTicketWhere(dayStart),
    select: {
      id: true,
      ticket_number: true,
      requestor: { select: { expo_push_token: true } },
      driver: { select: { expo_push_token: true } },
    },
  });
  if (stale.length === 0) return 0;

  let cancelled = 0;
  for (const trip of stale) {
    const won = await prisma.$transaction(async (tx) => {
      // CAS: only cancel while it's STILL in a not-yet-started status. A driver
      // tapping "Start"/"Deliver" between the query and here wins the race and
      // keeps their trip; the auto-cancel simply misses it.
      const res = await tx.trip.updateMany({
        where: { id: trip.id, status: { in: [...STALE_CANCELLABLE_STATUSES] } },
        data: { status: "cancelled", auto_dispatch_failed: false, auto_dispatch_note: AUTO_CANCEL_NOTE },
      });
      if (res.count !== 1) return false;
      // System event (actor null): the timeline records WHO/WHY without needing a
      // user row (AuditLog requires a real user; the 3am job has none).
      await recordTripEvent(tx, {
        tripId: trip.id,
        event: "cancelled",
        actorId: null,
        note: AUTO_CANCEL_NOTE,
      });
      return true;
    });
    if (!won) continue;
    cancelled += 1;

    // Best-effort: tell the requestor (and the freed driver, if any) it lapsed.
    await sendPushNotifications([trip.requestor?.expo_push_token, trip.driver?.expo_push_token], {
      title: "Booking auto-cancelled",
      body: `Trip ${trip.ticket_number} was not delivered and has been auto-cancelled — please rebook if still needed`,
      data: { type: "auto_cancelled", tripId: trip.id },
    });
  }

  if (cancelled > 0) {
    console.log(`[stale-ticket-sweep] auto-cancelled ${cancelled} undelivered ticket(s) past pickup day`);
  }
  return cancelled;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const CANCEL_HOUR_MYT = 3; // 03:00 MYT daily

/** Milliseconds from `now` until the next 03:00 MYT. Pure/exported for tests. */
export function msUntilNext3amMyt(now: Date): number {
  const mytNow = now.getTime() + MYT_OFFSET_MS;
  const dayStartMyt = Math.floor(mytNow / DAY_MS) * DAY_MS; // 00:00 MYT today (in shifted ms)
  let next = dayStartMyt + CANCEL_HOUR_MYT * 60 * 60 * 1000;
  if (next <= mytNow) next += DAY_MS; // already past 3am today → tomorrow's 3am
  return next - mytNow;
}

/**
 * Start the daily 3am stale-ticket auto-cancel. Runs once on boot (safe — the
 * predicate only ever cancels PRIOR-day undelivered tickets, so a restart at any
 * hour can't touch today's or future work), so a crash across 3am still gets
 * cleaned up; then schedules the next 03:00 MYT and every 24h after.
 */
export function startStaleTicketSweep(): void {
  const run = () => {
    sweepStaleTickets().catch((err) => console.error("Stale-ticket sweep failed:", err));
  };
  run(); // boot catch-up (predicate keeps it safe at any hour)
  const delay = msUntilNext3amMyt(new Date());
  setTimeout(() => {
    run();
    setInterval(run, DAY_MS);
  }, delay);
}
