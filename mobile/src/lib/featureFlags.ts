// Client feature flags. All default OFF: only the exact string "true" enables a
// flag, so an unset / blank / mistyped value can never turn a feature on. Read
// from an EXPO_PUBLIC_ env var (inlined at build on web/native), NOT app.json,
// so the flag can be flipped per-environment without touching the app manifest.
// Tests set process.env directly.

/**
 * Failed-delivery / exception workflow UI (Phase 1B). Off by default; enable with
 * EXPO_PUBLIC_FEATURE_EXCEPTIONS=true. While off, every exception surface (driver
 * Report-Exception, admin Exceptions lane, requestor banner) is hidden and no
 * exception request is ever made.
 */
export function exceptionsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS === "true";
}

/**
 * Request Change — the A19 approval flow for ASSIGNED bookings. Off by default;
 * enable with EXPO_PUBLIC_FEATURE_CHANGE_REQUESTS=true (must match the server's
 * FEATURE_CHANGE_REQUESTS, which 404s the routes while off).
 *
 * While off the requestor sees no Request Change button and the admin drawer
 * has no queue, so nothing can be submitted and nothing can pile up unseen.
 */
export function changeRequestsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_FEATURE_CHANGE_REQUESTS === "true";
}
