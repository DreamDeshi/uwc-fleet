import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";
import { getDispatchMode } from "../lib/settings";
import { autoDispatchTrip } from "./dispatchEngine";

// Reads a positive-integer minutes value from an env var, falling back to
// `fallback` if the var is unset or not a valid positive integer.
function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// How long a booking may sit unassigned before the engine retries auto-dispatch
// and (failing that) alerts admins. Override with PENDING_ALERT_THRESHOLD_MINUTES
// in the API env; defaults to 10 minutes.
const PENDING_ALERT_THRESHOLD_MINUTES = minutesFromEnv("PENDING_ALERT_THRESHOLD_MINUTES", 10);
const PENDING_ALERT_THRESHOLD_MS = PENDING_ALERT_THRESHOLD_MINUTES * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000; // sweep once a minute

// Every stale pending booking, alerted or not. Retrying and alerting are
// DELIBERATELY decoupled (audit 2026-07-16): the sweep used to select only
// `pending_alert_sent: false`, which made the same flag gate BOTH the one-shot
// admin alert and the dispatch retry — so the moment a booking's 10-minute
// alert fired, nothing ever re-evaluated it, and a truck freeing up an hour
// later never picked it up. The retry must keep covering alerted bookings;
// only the ALERT is one-shot (gated per-trip below). Exported for unit tests.
export const staleSweepWhere = (cutoff: Date) => ({
  status: "pending" as const,
  created_at: { lte: cutoff },
});

// Find pending bookings that have sat unassigned for ≥ the threshold. In auto
// mode the engine first tries to assign each one (with the adjacency-zone
// search expanded by the engine itself) — EVERY sweep, for as long as the
// booking stays pending. The ones it can't place ping the admins once:
// `pending_alert_sent` guards against re-notifying (it survives restarts and
// fires exactly once per trip) but no longer stops the retry.
// Exported so the integration suite can run one sweep deterministically.
export async function sweepPendingTrips(): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_ALERT_THRESHOLD_MS);

  const staleTrips = await prisma.trip.findMany({
    where: staleSweepWhere(cutoff),
    select: { id: true, ticket_number: true, pending_alert_sent: true },
  });
  if (staleTrips.length === 0) return;

  const autoMode = (await getDispatchMode()) === "auto";

  // In auto mode, attempt to dispatch each stale trip. autoDispatchTrip flips
  // pending_alert_sent itself on success, so a placed trip drops out of the
  // "needs alert" list below.
  const needAlert: { id: string; ticket_number: string }[] = [];
  for (const trip of staleTrips) {
    if (autoMode) {
      try {
        const result = await autoDispatchTrip(trip.id);
        if (result.assigned) continue; // placed — driver already notified
      } catch (err) {
        console.error(`Auto-dispatch retry failed for ${trip.ticket_number}:`, err);
      }
    }
    // One-shot alert: a booking that already pinged the admins is retried
    // above but never re-alerted.
    if (!trip.pending_alert_sent) needAlert.push(trip);
  }
  if (needAlert.length === 0) return;

  const admins = await prisma.user.findMany({
    where: { role: "admin", status: "active", expo_push_token: { not: null } },
    select: { expo_push_token: true },
  });
  const adminTokens = admins.map((a) => a.expo_push_token);

  for (const trip of needAlert) {
    await sendPushNotifications(adminTokens, {
      title: "Pending order",
      body: `Trip ${trip.ticket_number} has been pending for ${PENDING_ALERT_THRESHOLD_MINUTES} minute${
        PENDING_ALERT_THRESHOLD_MINUTES === 1 ? "" : "s"
      }`,
      data: { type: "pending_alert", tripId: trip.id },
    });
  }

  await prisma.trip.updateMany({
    where: { id: { in: needAlert.map((t) => t.id) } },
    data: { pending_alert_sent: true },
  });
}

/** Start the background sweep. Called once from index.ts on server boot. */
export function startPendingTripAlerts(): void {
  setInterval(() => {
    sweepPendingTrips().catch((err) => console.error("Pending-trip alert sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
