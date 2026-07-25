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
