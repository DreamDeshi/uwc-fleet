import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { biometricUnlockEnabled } from "./featureFlags";

/**
 * THE GATE IS WIRED, AND THE FLAG IS OFF.
 *
 * `biometricUnlock.test.ts` proves the DECISIONS — online/offline, what clears
 * an enrolment, when a password login wipes one. Every one of those functions
 * is pure and none of them proves anything runs. A correct gate that nothing
 * consults is the dead-code failure this repo keeps meeting; here it would be
 * worse than dead, because "the lock is on" would be a claim about a lock that
 * never renders.
 *
 * So this file asserts the WIRING, and each assertion is anchored on something
 * that has to be deleted for the feature to stop working — not on a string that
 * could drift.
 */

const SRC = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf-8");

const FLAG = "EXPO_PUBLIC_FEATURE_BIOMETRIC_UNLOCK";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

describe("biometric unlock — the flag", () => {
  it("is OFF when unset, and for anything but the exact string 'true'", () => {
    delete process.env[FLAG];
    expect(biometricUnlockEnabled()).toBe(false);
    for (const v of ["", "false", "1", "TRUE", "yes"]) {
      process.env[FLAG] = v;
      expect(biometricUnlockEnabled(), `flag=${JSON.stringify(v)}`).toBe(false);
    }
    process.env[FLAG] = "true";
    expect(biometricUnlockEnabled()).toBe(true);
  });
});

describe("biometric unlock — the gate is REACHED at bootstrap", () => {
  const auth = SRC("context/AuthContext.tsx");

  it("reads the file it claims to check", () => {
    expect(auth.length).toBeGreaterThan(5_000);
    expect(auth).toContain("export function AuthProvider");
  });

  it("checks the gate BEFORE resolving the session", () => {
    // Order is the whole point. Fetching the identity first would render the
    // app's own data behind the lock screen, and a lock you can read past is
    // decoration. Prove it by moving the call below `fetchMe`.
    const gateAt = auth.indexOf("if (await gateIsArmed())");
    expect(gateAt, "the bootstrap does not consult the gate at all").toBeGreaterThan(-1);

    const bootstrapAt = auth.indexOf("const hasTokens = await loadStoredTokens();");
    expect(bootstrapAt, "the bootstrap effect moved or was renamed").toBeGreaterThan(-1);

    const fetchAt = auth.indexOf("await fetchMe();", bootstrapAt);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(gateAt, "the gate must be consulted before fetchMe").toBeLessThan(fetchAt);
    expect(gateAt).toBeGreaterThan(bootstrapAt);
  });

  it("arms only on flag + hardware + an enrolment of ours", () => {
    const start = auth.indexOf("const gateIsArmed = async ()");
    expect(start).toBeGreaterThan(-1);
    const body = auth.slice(start, auth.indexOf("};", start));

    expect(body, "the flag must gate it").toContain("biometricUnlockEnabled()");
    expect(body, "hardware + OS enrolment must gate it").toContain("biometricAvailable()");
    expect(body, "our own enrolment must gate it").toContain("enrolledUserId()");
    // Fails OPEN: a throw anywhere in here must not lock anyone out.
    expect(body, "the gate must fail open").toContain("return false;");
  });

  it("applies the shared-handset rule on password login", () => {
    const start = auth.indexOf("const login = async (phone: string, password: string)");
    expect(start).toBeGreaterThan(-1);
    const body = auth.slice(start, auth.indexOf("const register =", start));

    expect(body, "a password login must consult the rule").toContain(
      "passwordLoginClearsEnrolment"
    );
    expect(body, "and act on it").toContain("clearEnrolment()");
  });

  it("renders the lock screen for the locked status", () => {
    const nav = SRC("navigation/RootNavigator.tsx");
    expect(nav).toContain('status === "locked"');
    expect(nav).toContain("<UnlockScreen />");
    // Before the guest branch, or an expired-looking session would fall through
    // to the password form and the lock would never show.
    expect(nav.indexOf('status === "locked"')).toBeLessThan(nav.indexOf('status === "guest"'));
  });

  it("offers the toggle only where it can work, and on every role's settings", () => {
    const row = SRC("components/BiometricUnlockRow.tsx");
    expect(row, "must render nothing when it cannot work").toContain(
      "if (!biometric.offerable) return null;"
    );
    for (const screen of ["screens/shared/ProfileScreen.tsx", "admin/screens/AdminSettingsScreen.tsx"]) {
      expect(SRC(screen), `${screen} must offer the toggle`).toContain("<BiometricUnlockRow");
    }
  });

  it("keeps web on the password path — no WebAuthn, no half-feature", () => {
    const enrol = SRC("lib/biometricEnrolment.ts");
    expect(enrol).toContain('if (Platform.OS === "web") return null;');
  });
});
