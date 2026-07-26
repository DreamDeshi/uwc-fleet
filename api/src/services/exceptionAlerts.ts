import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";
import { exceptionsEnabled } from "../lib/featureFlags";

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

function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

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
