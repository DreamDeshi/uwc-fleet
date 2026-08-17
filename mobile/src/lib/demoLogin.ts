// One-tap role entry for the SDG DEMO instance only.
//
// A judge scans a QR at the poster, lands on the login screen and has thirty
// seconds of attention. Typing a phone number and a password on a phone spends
// most of that, so the demo build offers three buttons that sign in as the
// seeded demo admin / driver / requestor. The normal form stays below them.
//
// PRODUCTION MUST NEVER RENDER THIS, so the gate is deliberately doubled:
//
//   1. EXPO_PUBLIC_FEATURE_DEMO_LOGIN must be the exact string "true" — the
//      same default-OFF shape as `featureFlags.ts` (unset / blank / "TRUE" /
//      "1" all read as off).
//   2. EXPO_PUBLIC_DEMO_PASSWORD must be a non-empty string. The demo password
//      is supplied by the demo service's build environment and is NOT in this
//      public repository, so a production build has nothing to sign in WITH
//      even if someone flipped the flag by mistake.
//
// Both are EXPO_PUBLIC_ vars, inlined at build time by Expo — the value is
// baked into the bundle that is built, not read at runtime, so the production
// bundle contains neither the buttons' credentials nor a way to obtain them.
//
// The phone numbers below are the demo instance's SYNTHETIC accounts. They are
// not real UWC staff numbers and they exist only on the demo database.

export type DemoRole = "admin" | "driver" | "requestor";

export interface DemoAccount {
  role: DemoRole;
  /** Full E.164 phone, as `AuthContext.login` expects it. */
  phone: string;
}

const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { role: "admin", phone: "+60100000001" },
  { role: "driver", phone: "+60100000101" },
  { role: "requestor", phone: "+60199990001" },
];

/**
 * The demo password, or null when the build carries none. Null is the
 * production case and the reason a stray flag alone cannot open a door.
 */
export function demoPassword(): string | null {
  const pw = process.env.EXPO_PUBLIC_DEMO_PASSWORD;
  return typeof pw === "string" && pw.length > 0 ? pw : null;
}

/**
 * True only on a build that BOTH asked for the demo switcher and carries a
 * password for it. Off by default, off in production.
 */
export function demoLoginEnabled(): boolean {
  return (
    process.env.EXPO_PUBLIC_FEATURE_DEMO_LOGIN === "true" && demoPassword() !== null
  );
}

/**
 * The accounts to offer, or an EMPTY LIST when the gate is shut. Callers render
 * from this list, so "gate shut" and "nothing to draw" are the same state and
 * no caller can forget the check and still draw a button.
 */
export function demoAccounts(): readonly DemoAccount[] {
  return demoLoginEnabled() ? DEMO_ACCOUNTS : [];
}
