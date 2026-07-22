// Pure decision logic for the BACKGROUND location task — import-free so it's
// unit-testable in plain node (same discipline as gpsTracking / podOutboxCore).
//
// The background task keeps capturing even when the app is closed or the phone
// is locked, so the ONE rule that must never break is: it may only ever be
// running for the trip that is genuinely active. Everything about starting,
// stopping and — critically — NOT leaking (tracking a trip that has ended)
// reduces to reconciling "what SHOULD be tracked" against "what IS tracked".

// Whether the background task should be capturing at all. Mirrors trackingGate
// (active + consented) but adds the OS "Always/Allow all the time" grant, since
// background capture is impossible without it. If any is false → no background
// task, and the caller falls back to the foreground path.
export function shouldTrackInBackground(
  active: boolean,
  consented: boolean,
  backgroundPermissionGranted: boolean
): boolean {
  return active && consented && backgroundPermissionGranted;
}

export type BgAction = "start" | "stop" | "restart" | "noop";

// Reconcile desired vs running tracked trip. `desiredTripId` is the trip that
// SHOULD be tracked right now (or null if nothing should be), `runningTripId`
// is the trip the task is currently running for (or null if the task is idle).
//
//   null  vs null   → noop
//   T     vs T      → noop            (already tracking the right trip)
//   null  vs T      → stop            (LEAK guard: a trip ended, kill the task)
//   T     vs null   → start
//   T     vs U       → restart        (driver switched trips — stop old, start new)
export function backgroundTrackingAction(
  desiredTripId: string | null,
  runningTripId: string | null
): BgAction {
  if (desiredTripId === runningTripId) return "noop";
  if (desiredTripId === null) return "stop";
  if (runningTripId === null) return "start";
  return "restart";
}
