import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";
import { getDispatchMode } from "../lib/settings";
import { autoDispatchTrip } from "./dispatchEngine";
import { minutesFromEnv } from "../lib/envNumbers";
import { effectivePendingTripAlertThresholds } from "../lib/alertThresholdSettings";

// Reads a positive-integer minutes value from an env var, falling back to
// `fallback` if the var is unset or not a valid positive integer.

// How long a booking may sit unassigned before the engine retries auto-dispatch
// and (failing that) alerts admins. Override with PENDING_ALERT_THRESHOLD_MINUTES
// in the API env; defaults to 10 minutes. EXPORTED for settingsRegistry.ts's
// default (Phase 4) — was module-private until then, nothing else needed it.
export const PENDING_ALERT_THRESHOLD_MINUTES = minutesFromEnv("PENDING_ALERT_THRESHOLD_MINUTES", 10);

// Retry CEILING — the point past which the sweep stops re-attempting a stuck
// pending booking and escalates it to a human instead (DG-T1). Two triggers:
//   • pickup passed — a still-pending booking whose pickup moment has arrived can
//     no longer be fulfilled on time; retrying could only produce a days-late
//     auto-assignment, so give up immediately.
//   • age ceiling — a generous backstop for far-future bookings that never place;
//     override with PENDING_RETRY_CEILING_MINUTES, default 24h.
// Without this, the sweep re-dispatched every stale pending booking every minute
// forever (the retry/alert-decoupling fix removed the only thing that ever
// stopped it).
export const PENDING_RETRY_CEILING_MINUTES = minutesFromEnv("PENDING_RETRY_CEILING_MINUTES", 24 * 60);
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
  // Manual-hold pin (feedback item 15): a trip an admin unassigned stays pinned
  // to manual handling — the sweep neither auto-dispatches nor re-alerts on it.
  // Cleared the moment it's (re-)assigned, so this only ever excludes trips the
  // admin is deliberately holding in pending.
  auto_dispatch_paused: false,
});

export type ExpiryReason = "pickup_passed" | "retry_ceiling";

/**
 * Why a still-pending booking should STOP being auto-retried, or null while it's
 * still worth trying. Pure (no DB) — unit-tested. `retryCeilingMs` defaults to
 * the module constant so every existing call that omits it keeps today's exact
 * behaviour. See PENDING_RETRY_CEILING_*.
 */
export function pendingRetryExpired(
  trip: { pickup_datetime: Date; created_at: Date },
  now: number,
  retryCeilingMs: number = PENDING_RETRY_CEILING_MINUTES * 60 * 1000
): ExpiryReason | null {
  if (trip.pickup_datetime.getTime() <= now) return "pickup_passed";
  if (now - trip.created_at.getTime() >= retryCeilingMs) return "retry_ceiling";
  return null;
}

// STABLE note text — never embeds a variable, so it never changes. Exported
// for pendingTripAlerts.test.ts, which pins the stale-marker fix directly.
export const PICKUP_PASSED_NOTE =
  "Pickup time passed while still unassigned — assign manually or ask the requestor to rebook.";
// The retry-ceiling note DOES embed the (now admin-editable) ceiling minutes,
// so its full text can change between sweeps. Only the PREFIX is stable —
// that's what the one-shot marker below keys on, not the number.
export const RETRY_CEILING_NOTE_PREFIX = "Could not be auto-assigned within ";
export function retryCeilingNote(retryCeilingMin: number): string {
  return `${RETRY_CEILING_NOTE_PREFIX}${retryCeilingMin} minutes — assign manually.`;
}

/**
 * One-shot marker for "already escalated to manual by the ceiling". The engine
 * sets auto_dispatch_failed + its own note on every failed *in-window* attempt
 * (e.g. "No available truck…"), so that flag can't distinguish a transient
 * failure from a final give-up. The expiry note itself is the marker: once it's
 * been stamped, the booking is not re-escalated or re-alerted.
 *
 * ⚠ Phase 4: this used to be an exact-string Set built from the note text —
 * which EMBEDS the retry-ceiling minutes. Once that number became admin-
 * editable, a trip escalated under the OLD value would stop matching the SAME
 * check re-built from the NEW value on the next sweep, and get silently
 * re-escalated (a duplicate "Booking expired" push for something already
 * handled). Matching on the stable prefix instead of the full string is what
 * keeps the marker independent of the setting's current value.
 */
export function alreadyEscalated(note: string | null): boolean {
  return note === PICKUP_PASSED_NOTE || (note?.startsWith(RETRY_CEILING_NOTE_PREFIX) ?? false);
}

async function activeAdminPushTokens(): Promise<(string | null)[]> {
  const admins = await prisma.user.findMany({
    where: { role: "admin", status: "active", expo_push_token: { not: null } },
    select: { expo_push_token: true },
  });
  return admins.map((a) => a.expo_push_token);
}

// Find pending bookings that have sat unassigned for ≥ the threshold. In auto
// mode the engine retries each one it hasn't yet given up on — EVERY sweep, for
// as long as the booking stays pending AND is still within the retry ceiling.
// Past the ceiling (pickup passed / too old), a booking is flagged for manual
// handling with a one-shot "expired" alert and never retried again. Ones it
// still can't place ping the admins once (`pending_alert_sent`, one-shot).
// Exported so the integration suite can run one sweep deterministically.
export async function sweepPendingTrips(): Promise<void> {
  const now = Date.now();
  // Admin-settings Phase 4 — both thresholds are now admin-editable.
  const { pendingTripThresholdMin, pendingRetryCeilingMin } = await effectivePendingTripAlertThresholds();
  const pendingThresholdMs = pendingTripThresholdMin * 60 * 1000;
  const retryCeilingMs = pendingRetryCeilingMin * 60 * 1000;
  const cutoff = new Date(now - pendingThresholdMs);

  const staleTrips = await prisma.trip.findMany({
    where: staleSweepWhere(cutoff),
    select: {
      id: true,
      ticket_number: true,
      pending_alert_sent: true,
      pickup_datetime: true,
      created_at: true,
      auto_dispatch_note: true,
    },
  });
  if (staleTrips.length === 0) return;

  const autoMode = (await getDispatchMode()) === "auto";

  const needAlert: { id: string; ticket_number: string }[] = [];
  const expired: { id: string; ticket_number: string; reason: ExpiryReason }[] = [];

  for (const trip of staleTrips) {
    const reason = pendingRetryExpired(trip, now, retryCeilingMs);
    if (reason) {
      // Ceiling reached: never retry this booking again. Escalate to manual with
      // a one-shot "expired" alert the FIRST time it crosses — keyed on the
      // expiry note (see alreadyEscalated), so a booking already escalated just
      // stops being retried, silently.
      if (!alreadyEscalated(trip.auto_dispatch_note)) {
        expired.push({ id: trip.id, ticket_number: trip.ticket_number, reason });
      }
      continue;
    }

    if (autoMode) {
      try {
        const result = await autoDispatchTrip(trip.id);
        if (result.assigned) continue; // placed — driver already notified
      } catch (err) {
        console.error(`Auto-dispatch retry failed for ${trip.ticket_number}:`, err);
      }
    }
    // One-shot alert: a booking that already pinged the admins is retried above
    // but never re-alerted.
    if (!trip.pending_alert_sent) needAlert.push(trip);
  }

  if (expired.length === 0 && needAlert.length === 0) return;

  const adminTokens = await activeAdminPushTokens();

  // Expired → escalate to manual: one alert each, then flag + note (per reason).
  for (const t of expired) {
    await sendPushNotifications(adminTokens, {
      title: "Booking expired",
      body: `Trip ${t.ticket_number} ${
        t.reason === "pickup_passed"
          ? "passed its pickup time while unassigned"
          : "could not be auto-assigned in time"
      } — needs manual handling`,
      data: { type: "pending_expired", tripId: t.id },
    });
  }
  for (const reason of ["pickup_passed", "retry_ceiling"] as const) {
    const ids = expired.filter((t) => t.reason === reason).map((t) => t.id);
    if (ids.length > 0) {
      const note = reason === "pickup_passed" ? PICKUP_PASSED_NOTE : retryCeilingNote(pendingRetryCeilingMin);
      await prisma.trip.updateMany({
        where: { id: { in: ids } },
        data: { auto_dispatch_failed: true, auto_dispatch_note: note },
      });
    }
  }

  // One-shot "still pending" alert.
  for (const trip of needAlert) {
    await sendPushNotifications(adminTokens, {
      title: "Pending order",
      body: `Trip ${trip.ticket_number} has been pending for ${pendingTripThresholdMin} minute${
        pendingTripThresholdMin === 1 ? "" : "s"
      }`,
      data: { type: "pending_alert", tripId: trip.id },
    });
  }
  if (needAlert.length > 0) {
    await prisma.trip.updateMany({
      where: { id: { in: needAlert.map((t) => t.id) } },
      data: { pending_alert_sent: true },
    });
  }
}

/** Start the background sweep. Called once from index.ts on server boot. */
export function startPendingTripAlerts(): void {
  setInterval(() => {
    sweepPendingTrips().catch((err) => console.error("Pending-trip alert sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
