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
  /** REQUIRED by the rule — see the arrival guard below. */
  arrived_at?: string | null;
  exceptions?: {
    current_state: string;
    resolution: string | null;
    actions?: { type: string }[];
  }[];
}

export function isStopSettled(stop: SettleableStop): boolean {
  if (stop.status === "delivered") return false;
  // THE ARRIVAL GUARD — all THREE server conditions, not two.
  //
  // Q11(b), "if the lorry breakdown halfway, no incentive": a stop the driver
  // never REACHED earns nothing and is still his to deliver. Dropping this
  // condition here silently hid live work: the report sheet attaches a `truck`
  // or `external` exception to the driver's NEXT stop (pending, no arrival), so
  // a breakdown en route, verified and resumed, made that stop vanish from his
  // rail while the server still counted it outstanding — the trip could never
  // finalize and he was never offered a way to deliver it.
  if (!stop.arrived_at) return false;
  const exceptions = stop.exceptions ?? [];
  // AN EXPLICIT REJECT WINS (owner ruling, 30 Jul 2026) — mirrors the server's
  // `none: { current_state: "rejected" }`. Reject is the no-pay lever, so it
  // must beat an approval on the same stop; otherwise it means nothing whenever
  // a second report exists.
  //
  // ⚠ THIS IS THE **PAY** QUESTION ONLY. For "does the driver still owe this
  // stop", use isStopAdjudicated below — a vetoed stop is still CLOSED OUT.
  // Answering both with this one function is what stranded trips server-side.
  if (exceptions.some((e) => e.current_state === "rejected")) return false;
  return hasApproval(exceptions);
}

/** Verified + resumed: the office closed this stop out. NO reject veto. */
function hasApproval(exceptions: NonNullable<SettleableStop["exceptions"]>): boolean {
  return exceptions.some(
    (e) =>
      e.current_state === "resolved" &&
      e.resolution === "resume" &&
      (e.actions ?? []).some((a) => a.type === "verify")
  );
}

/**
 * Is this stop CLOSED OUT — settled, or adjudicated-but-vetoed? Either way the
 * office decided and the driver does not owe it, so it must leave his rail and
 * must not hold the trip open. Mirrors ADJUDICATED_UNDELIVERED_WHERE.
 */
export function isStopAdjudicated(stop: SettleableStop): boolean {
  if (stop.status === "delivered") return true;
  if (!stop.arrived_at) return false;
  return hasApproval(stop.exceptions ?? []);
}

/**
 * The stops still outstanding, in order — what "next stop", the Active Trip
 * rail and the Home card should all be counting. Deliberately ONE helper so
 * the three screens cannot drift apart.
 */
export function outstandingStops<T extends SettleableStop>(stops: T[]): T[] {
  // ADJUDICATED, not settled: a stop whose pay was vetoed by a rejection is
  // still decided, so it leaves the rail. Using isStopSettled here would show
  // the driver work the server no longer counts outstanding.
  return stops.filter((s) => s.status !== "delivered" && !isStopAdjudicated(s));
}
