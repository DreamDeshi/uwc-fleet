import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000; // sweep once a minute

// Find pending bookings that have sat unassigned for ≥15 minutes and ping every
// active admin once. `pending_alert_sent` guards against re-notifying, so the
// alert survives restarts and fires exactly once per trip.
async function sweepPendingTrips(): Promise<void> {
  const cutoff = new Date(Date.now() - FIFTEEN_MINUTES_MS);

  const staleTrips = await prisma.trip.findMany({
    where: { status: "pending", pending_alert_sent: false, created_at: { lte: cutoff } },
    select: { id: true, ticket_number: true },
  });
  if (staleTrips.length === 0) return;

  const admins = await prisma.user.findMany({
    where: { role: "admin", status: "active", expo_push_token: { not: null } },
    select: { expo_push_token: true },
  });
  const adminTokens = admins.map((a) => a.expo_push_token);

  for (const trip of staleTrips) {
    await sendPushNotifications(adminTokens, {
      title: "Pending order",
      body: `Trip ${trip.ticket_number} has been pending for 15 minutes`,
      data: { type: "pending_alert", tripId: trip.id },
    });
  }

  await prisma.trip.updateMany({
    where: { id: { in: staleTrips.map((t) => t.id) } },
    data: { pending_alert_sent: true },
  });
}

/** Start the background sweep. Called once from index.ts on server boot. */
export function startPendingTripAlerts(): void {
  setInterval(() => {
    sweepPendingTrips().catch((err) => console.error("Pending-trip alert sweep failed:", err));
  }, CHECK_INTERVAL_MS);
}
