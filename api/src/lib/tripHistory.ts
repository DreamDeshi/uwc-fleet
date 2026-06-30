import type { Prisma, PrismaClient, TripEvent } from "@prisma/client";

// Accepts either the base client or a transaction client, so callers inside a
// $transaction (e.g. the approve path) write the history row atomically with the
// status change, and plain callers write it directly.
type TripHistoryClient = PrismaClient | Prisma.TransactionClient;

/**
 * Append one immutable milestone to a trip's status history. Best-effort context
 * goes in `note` ("<driver> · <plate>", a rejection reason, a forwarder name);
 * `actorId` is null for system events (auto-dispatch, the background sweep);
 * `stopId` is set only for per-stop events.
 */
export async function recordTripEvent(
  client: TripHistoryClient,
  args: {
    tripId: string;
    event: TripEvent;
    stopId?: string | null;
    actorId?: string | null;
    note?: string | null;
  }
): Promise<void> {
  await client.tripStatusHistory.create({
    data: {
      trip_id: args.tripId,
      event: args.event,
      stop_id: args.stopId ?? null,
      actor_id: args.actorId ?? null,
      note: args.note ?? null,
    },
  });
}
