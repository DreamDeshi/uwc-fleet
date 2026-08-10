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

/** One tappable role on the demo login screen. */
export interface DemoRole {
  role: "admin" | "requestor" | "driver";
  phone: string;
}

/**
 * DEMO ROLE PICKER — the public SDG demo instance ONLY.
 *
 * The demo is shown to a room of people who cannot be handed a phone number and
 * password each, so its login screen offers "continue as admin / requestor /
 * driver" instead of a form. That is only ever acceptable on a throwaway,
 * anonymous instance.
 *
 * ⚠ THE ACCOUNTS ARE NOT IN THIS REPOSITORY, AND MUST NOT BE. Every phone and
 * the shared password come from EXPO_PUBLIC_ env vars set on the DEMO
 * deployment and nowhere else. Three consequences, all deliberate:
 *
 *   - Production sets none of them, so `demoRoles()` returns [] there and the
 *     picker cannot render even if the flag were switched on by mistake.
 *   - No credential is committed, so this stays true if the repo is read by
 *     anyone (it is public).
 *   - On PRODUCTION the phones +60100000101…106 belong to REAL employees. A
 *     hardcoded "driver" default would have signed a stranger into a real
 *     driver's account the moment a flag was mis-set. There is no default.
 *
 * The password is required as well as the flag, so a half-configured
 * deployment shows the ordinary login form rather than dead buttons.
 */
export function demoRoles(): DemoRole[] {
  if (process.env.EXPO_PUBLIC_DEMO_MODE !== "true") return [];
  if (!process.env.EXPO_PUBLIC_DEMO_PASSWORD) return [];
  // Referenced as full literals — the bundler inlines these by exact name, so
  // they cannot be built up dynamically.
  const configured: Array<{ role: DemoRole["role"]; phone: string | undefined }> = [
    { role: "admin", phone: process.env.EXPO_PUBLIC_DEMO_ADMIN_PHONE },
    { role: "requestor", phone: process.env.EXPO_PUBLIC_DEMO_REQUESTOR_PHONE },
    { role: "driver", phone: process.env.EXPO_PUBLIC_DEMO_DRIVER_PHONE },
  ];
  return configured.filter((c): c is DemoRole => typeof c.phone === "string" && c.phone.length > 0);
}

/** The demo's shared password. Empty unless the demo build supplied one. */
export function demoPassword(): string {
  return process.env.EXPO_PUBLIC_DEMO_PASSWORD ?? "";
}
