/**
 * Is this stop still the driver's to do?
 *
 * Since R3 Q11(a) a stop can leave the driver's hands WITHOUT being delivered:
 * he reached it, could not deliver, and an admin verified the report and closed
 * it with "Do not return". That stop is SETTLED — paid at the normal rate, with
 * nothing left for him to do. Its `status` is still "pending"/"arrived" (the
 * per-stop record stays truthful about what was and wasn't delivered), so every
 * `status !== "delivered"` test in the app reads it as outstanding and keeps
 * offering him a POD button for a stop the office has already closed and paid.
 *
 * Mirrors the server rule in api/src/services/undeliveredPay.ts EXACTLY —
 * verify AND resume, because `resolved` alone is also produced by a bare
 * "Resume trip" (an admin unblocking a stuck truck, no adjudication) and by
 * "Retry", which deliberately settles nothing so the driver CAN go back.
 * Keep the two in step.
 */
export interface SettleableStop {
  status: string;
  exceptions?: {
    current_state: string;
    resolution: string | null;
    actions?: { type: string }[];
  }[];
}

export function isStopSettled(stop: SettleableStop): boolean {
  if (stop.status === "delivered") return false;
  return (stop.exceptions ?? []).some(
    (e) =>
      e.current_state === "resolved" &&
      e.resolution === "resume" &&
      (e.actions ?? []).some((a) => a.type === "verify")
  );
}

/**
 * The stops still outstanding, in order — what "next stop", the Active Trip
 * rail and the Home card should all be counting. Deliberately ONE helper so
 * the three screens cannot drift apart.
 */
export function outstandingStops<T extends SettleableStop>(stops: T[]): T[] {
  return stops.filter((s) => s.status !== "delivered" && !isStopSettled(s));
}
