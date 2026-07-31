import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";
import { exceptionsEnabled } from "../lib/featureFlags";
import { minutesFromEnv } from "../lib/envNumbers";

// Overdue-open-exception alert sweep (failed-delivery plan, [R] alert-only).
//
// A driver-reported exception PAUSES a trip operationally: delivered/continue/
// abort all 409 EXCEPTION_OPEN until an admin acts. If nobody notices the
// report, the truck sits stranded — so once an exception has been open longer
// than the threshold, ping the admins ONCE. Alert-only by design: no
// auto-action, no state change, no schema.
//
// One-shot marker is IN-PROCESS (a module Set): AuditLog can't carry it
// (user_id is a required FK and this sweep has no actor) and adding a column
// is schema — deliberately avoided. Consequence: a server restart re-alerts
// each still-open overdue exception once. For an alert, the tolerable
// direction — a lost reminder would be worse than a duplicate one.
//
// The FEATURE_EXCEPTIONS flag is read PER SWEEP (same discipline as the
// routes): while the feature is dark this sweep does nothing, and flipping the
// flag needs no redeploy.


// How long an exception may stay open before admins are pinged. Override with
// EXCEPTION_ALERT_THRESHOLD_MINUTES; defaults to 30 minutes.
export const EXCEPTION_ALERT_THRESHOLD_MINUTES = minutesFromEnv(
  "EXCEPTION_ALERT_THRESHOLD_MINUTES",
  30
);
const EXCEPTION_ALERT_THRESHOLD_MS = EXCEPTION_ALERT_THRESHOLD_MINUTES * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000; // sweep once a minute

// Exception ids already alerted this process lifetime. Closed exceptions are
// pruned each sweep so the set tracks (at most) the open workload.
const alertedIds = new Set<string>();

/**
 * Which of the given OPEN exceptions are overdue and not yet alerted. Pure
 * (no DB) — unit-tested.
 */
export function overdueUnalerted<T extends { id: string; reported_at: Date }>(
  open: T[],
  alerted: ReadonlySet<string>,
  now: number
): T[] {
  return open.filter(
    (e) => now - e.reported_at.getTime() >= EXCEPTION_ALERT_THRESHOLD_MS && !alerted.has(e.id)
  );
}

/** One sweep pass. Exported so the integration suite can run it deterministically. */
export async function sweepOverdueExceptions(): Promise<void> {
  if (!exceptionsEnabled()) return;

  const open = await prisma.tripException.findMany({
    where: { closed_at: null },
    select: {
      id: true,
      reported_at: true,
      category: true,
      current_state: true,
      trip: { select: { id: true, ticket_number: true } },
    },
  });

  // Prune closed/gone exceptions from the one-shot set.
  const openIds = new Set(open.map((e) => e.id));
  for (const id of alertedIds) if (!openIds.has(id)) alertedIds.delete(id);
  if (open.length === 0) return;

  const due = overdueUnalerted(open, alertedIds, Date.now());
  if (due.length === 0) return;

  const admins = await prisma.user.findMany({
    where: { role: "admin", status: "active", expo_push_token: { not: null } },
    select: { expo_push_token: true },
  });
  const adminTokens = admins.map((a) => a.expo_push_token);

  for (const exc of due) {
    await sendPushNotifications(adminTokens, {
      title: "Exception needs a decision",
      body: `Trip ${exc.trip.ticket_number} has had an open ${exc.category} exception for over ${EXCEPTION_ALERT_THRESHOLD_MINUTES} minutes (${exc.current_state}) — the trip is paused until you act`,
      data: { type: "exception_overdue", tripId: exc.trip.id, exceptionId: exc.id },
    });
    alertedIds.add(exc.id);
  }
}

/**
 * AT-REPORT alert — fired the moment a driver files an exception.
 *
 * The sweep above is a BACKSTOP, not the notification. Waiting up to 30 minutes
 * to tell anyone that a loaded truck has stopped is the wrong default: the whole
 * trip is paused from the instant the report commits (delivered/abort both 409
 * EXCEPTION_OPEN), so the useful moment to reach an admin is now, not half an
 * hour of stranded truck later.
 *
 * Both alerts survive on purpose and say DIFFERENT things:
 *   - this one: "a driver just reported X" — new information;
 *   - the sweep: "nobody has acted on this in 30 minutes" — an escalation.
 * So the sweep deliberately does NOT skip exceptions this already alerted.
 *
 * Best-effort and never throws: a push failure must not fail or roll back a
 * report the driver has already committed (his evidence photo is uploaded and
 * the trip is already paused — losing the report would be far worse than
 * losing the notification). Fire-and-forget from the route, AFTER the commit.
 */
export async function alertExceptionReported(exceptionId: string): Promise<void> {
  try {
    if (!exceptionsEnabled()) return;
    const exc = await prisma.tripException.findUnique({
      where: { id: exceptionId },
      select: {
        id: true,
        category: true,
        reason: true,
        trip: {
          select: {
            id: true,
            ticket_number: true,
            truck_plate: true,
            driver: { select: { name: true } },
          },
        },
        trip_stop: { select: { sequence: true, consignee: { select: { company_name: true } } } },
      },
    });
    if (!exc) return;

    const admins = await prisma.user.findMany({
      where: { role: "admin", status: "active", expo_push_token: { not: null } },
      select: { expo_push_token: true },
    });
    // No early return on an empty admin list — sendPushNotifications handles
    // that, and the sweep above behaves the same way. Diverging here made the
    // two alerts behave differently on a fleet with no registered devices.

    // Who and where, then what — an admin reading a lock screen needs to know
    // which truck has stopped before anything else.
    const who = [exc.trip.driver?.name, exc.trip.truck_plate].filter(Boolean).join(" · ");
    const where = exc.trip_stop
      ? ` at stop ${exc.trip_stop.sequence} (${exc.trip_stop.consignee.company_name})`
      : "";
    await sendPushNotifications(
      admins.map((a) => a.expo_push_token),
      {
        title: `Driver reported: ${exc.category.replace(/_/g, " ")}`,
        body: `${who || exc.trip.ticket_number}${where} — ${truncate(exc.reason, 90)}. The trip is paused until you act.`,
        data: { type: "exception_reported", tripId: exc.trip.id, exceptionId: exc.id },
      }
    );
  } catch (err) {
    console.error("At-report exception alert failed:", err);
  }
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Test hook: reset the in-process one-shot marker between test cases. */
export function resetExceptionAlertMarkers(): void {
  alertedIds.clear();
}

/** Start the background sweep. Called once from index.ts on server boot. */
export function startExceptionAlerts(): void {
  setInterval(() => {
    sweepOverdueExceptions().catch((err) => console.error("Exception alert sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
