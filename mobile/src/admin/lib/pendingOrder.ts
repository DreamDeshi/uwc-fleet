// Ordering for the "Pending Dispatch" column. The server returns trips
// newest-created-first, which puts the booking that has waited LONGEST for a
// decision at the bottom — the opposite of how a dispatcher works the queue.
// Urgency = earliest pickup first; creation time breaks ties (oldest first)
// so two bookings for the same slot keep FIFO fairness.
export function byPickupUrgency(
  a: { pickup_datetime: string; created_at: string },
  b: { pickup_datetime: string; created_at: string }
): number {
  const pickup = new Date(a.pickup_datetime).getTime() - new Date(b.pickup_datetime).getTime();
  if (pickup !== 0) return pickup;
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}
