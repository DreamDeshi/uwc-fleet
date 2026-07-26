import type { Prisma } from "@prisma/client";

/**
 * Serialize all lifecycle transitions for ONE trip at the database level: take a
 * row-level `FOR UPDATE` lock on the Trip row inside the caller's transaction.
 * Every path that changes a trip's lifecycle — opening a TripException and the
 * Arrived/Delivered stop mutations (incl. the final-delivery finalization) — locks
 * the trip FIRST, then RE-READS and re-validates status / driver / open_exception_id
 * / stop status under the lock. Two such transactions on the same trip therefore
 * run strictly one-after-another, closing the "delivered committed but an exception
 * opened before finalization" gap. Callers MUST re-read after locking (never trust
 * a value read before the lock).
 */
export async function lockTripRow(tx: Prisma.TransactionClient, tripId: string): Promise<void> {
  // Parameterised raw query — the lock is released when the transaction ends.
  await tx.$queryRaw`SELECT id FROM "Trip" WHERE id = ${tripId} FOR UPDATE`;
}
