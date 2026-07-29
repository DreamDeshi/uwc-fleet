// Starting a trip now has TWO entry points: Trip Details (as always) and the
// approved Home card, whose single action is "Start this trip". Both must
// reconcile the same way, so the decision lives here instead of being written
// twice.
//
// THE RACE (audit 2026-07-05 #7): the tap commits server-side and the response
// is lost. The retry then meets a trip that is ALREADY in_progress, which the
// API refuses — usually 400 INVALID_STATUS (the plain pre-read fires before the
// CAS), and only in the tight read-to-CAS window TRIP_STATE_CHANGED. Both mean
// "someone already started it"; the caller re-reads the trip and, if it really
// is running, proceeds exactly as though the tap had succeeded.
//
// The status recheck is what keeps this safe. A genuine refusal — an admin
// unassigned the trip, or another run is already live — leaves the status
// somewhere other than in_progress and the caller surfaces the error.

/** Error codes that mean "re-read the trip before believing this failed". */
export function shouldReconcileStart(code: string | undefined | null): boolean {
  return code === "TRIP_STATE_CHANGED" || code === "INVALID_STATUS";
}
