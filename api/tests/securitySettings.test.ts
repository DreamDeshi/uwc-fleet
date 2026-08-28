import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { resolveSecurityLimit } from "../src/lib/envLimit";
import { getSettingDef, zodSchemaFor } from "../src/lib/settingsRegistry";

/**
 * Admin-settings Phase 5 (28 Aug 2026) — security.login_lockout_max_attempts /
 * security.login_lockout_minutes.
 *
 * `effectiveLockoutConfig()` (lib/securitySettings.ts) deliberately delegates
 * to loginLockout.ts's OWN env+default resolver (`lockoutConfig()`, built on
 * envLimit.ts's `resolveSecurityLimit`) for the non-DB-override case, rather
 * than duplicating that parsing via the registry's generic env-var mechanism
 * — see that file's own comment for why. The registry entries still carry
 * `envVar` purely so the admin UI's "source" badge reports accurately.
 *
 * That split has exactly one failure mode: if the two parsers ever disagreed
 * on what counts as a valid override, the badge could say "env" (or
 * "default") while a DIFFERENT number is actually governing logins. This
 * pins that they agree across the boundary cases envLimit.ts's own header
 * warns two independent copies of a security parser are prone to drift on.
 */
describe("resolveSecurityLimit and the registry's own env parsing agree (the badge cannot lie)", () => {
  const maxAttemptsDef = getSettingDef("security.login_lockout_max_attempts")!;
  const lockMinutesDef = getSettingDef("security.login_lockout_minutes")!;

  const CASES: { raw: string | undefined; label: string }[] = [
    { raw: "10", label: "an ordinary valid value" },
    { raw: "0", label: "zero — the explicit 'disabled' value" },
    { raw: "-5", label: "a negative number" },
    { raw: "3.5", label: "a non-integer" },
    { raw: "off", label: "a non-numeric string" },
    { raw: "", label: "an empty string" },
    { raw: "  ", label: "whitespace only" },
    { raw: undefined, label: "unset" },
  ];

  for (const def of [maxAttemptsDef, lockMinutesDef]) {
    describe(def.key, () => {
      for (const { raw, label } of CASES) {
        it(`agrees on: ${label} (${JSON.stringify(raw)})`, () => {
          const FALLBACK = -1; // a value neither parser could ever produce validly
          const resolveSecurityLimitAccepted = resolveSecurityLimit(raw, FALLBACK) !== FALLBACK;
          // Mirrors what settingsRegistry.ts's private parseValue() does for the
          // "minutes"/"integer" types: Number.isInteger + the def's own bounds.
          // Empty/whitespace/unset never reach parseValue at all (the registry
          // treats a blank env var as "not set"), matching resolveSecurityLimit's
          // OWN blank-means-unset rule — so both must reject here too.
          const registryAccepted =
            raw !== undefined &&
            raw.trim() !== "" &&
            zodSchemaFor(def).safeParse(Number(raw)).success;
          expect(registryAccepted, `${def.key}: ${label}`).toBe(resolveSecurityLimitAccepted);
        });
      }
    });
  }
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("effectiveLockoutConfig is actually called from the login route", () => {
  it("auth.ts's /login handler calls effectiveLockoutConfig(), not the bare lockoutConfig()", () => {
    const src = stripComments(readFileSync(join(__dirname, "..", "src", "routes", "auth.ts"), "utf8"));
    expect(src).toContain("const lockout = await effectiveLockoutConfig();");
    // The bare sync function must not be called directly from the route
    // anymore — effectiveLockoutConfig() is the only thing that should decide
    // the live threshold, or an admin's Setting row would be silently ignored.
    expect(src).not.toContain("lockoutConfig()");
  });
});
