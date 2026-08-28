import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { resolveSecurityLimit } from "../src/lib/envLimit";
import { getSettingDef, zodSchemaFor } from "../src/lib/settingsRegistry";
import { GLOBAL_RATE_LIMIT_DEFAULT, SENSITIVE_RATE_LIMIT_DEFAULT } from "../src/middleware/rateLimit";

/**
 * Admin-settings Phase 6 (28 Aug 2026) — rate_limit.global_max /
 * rate_limit.sensitive_max.
 *
 * ⚠ WHY THIS PHASE HAS NO LIVE FULL-APP INTEGRATION TEST, UNLIKE PHASES 2-5.
 * Every prior phase proved reach by PATCHing a setting through the real
 * running app and observing a real request's outcome change. That is not
 * possible here: `tests-integration/setup.ts` forces both
 * RATE_LIMIT_MAX=0 and SENSITIVE_RATE_LIMIT_MAX=0 for the WHOLE suite
 * (deliberately — see rateLimitKey.test.ts's own header on why every other
 * test needs the limiters out of the way), and app.ts reads that env var
 * ONCE at module import to decide whether to build a real limiter AT ALL.
 * By the time any integration test runs, that decision is already frozen for
 * the rest of the process — there is no way to get a "second" app instance
 * with the limiter enabled inside the same Vitest run.
 *
 * So reach is proven in three independent, narrower pieces instead:
 *  1. HERE — source-scan unit tests confirming app.ts and rateLimit.ts
 *     actually call the resolvers when the limiter IS enabled.
 *  2. tests-integration/rateLimitSettings.test.ts — the resolver itself
 *     (DB override, cache, fallback) against a real Postgres, called
 *     directly rather than through a live HTTP request.
 *  3. tests/rateLimitKey.test.ts — a bespoke Express app (this repo's
 *     existing pattern for exercising the limiter in isolation) proving
 *     `createGlobalRateLimiter` genuinely RE-INVOKES a function-valued limit
 *     per request, including an async one, which is the mechanism the live
 *     settings path depends on.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 6 rate-limit settings are wired into both limiters when enabled", () => {
  it("app.ts's global limiter consults effectiveGlobalRateLimitMax", () => {
    const src = stripComments(readFileSync(join(__dirname, "..", "src", "app.ts"), "utf8"));
    expect(src).toContain("effectiveGlobalRateLimitMax(RATE_LIMIT_MAX)");
  });

  it("sensitiveRateLimiter consults effectiveSensitiveRateLimitMax", () => {
    const src = stripComments(
      readFileSync(join(__dirname, "..", "src", "middleware", "rateLimit.ts"), "utf8")
    );
    expect(src).toContain("effectiveSensitiveRateLimitMax(SENSITIVE_MAX)");
  });
});

describe("settingsRegistry's rate-limit defaults match middleware/rateLimit.ts's own", () => {
  // The registry stores these as LITERALS (importing the real constants would
  // create a cycle — see settingsRegistry.ts's own comment). This is the pin
  // that catches the two drifting apart.
  it("stay equal", () => {
    expect(getSettingDef("rate_limit.global_max")?.default).toBe(GLOBAL_RATE_LIMIT_DEFAULT);
    expect(getSettingDef("rate_limit.sensitive_max")?.default).toBe(SENSITIVE_RATE_LIMIT_DEFAULT);
  });
});

describe("resolveSecurityLimit and the registry's own env parsing agree for the rate-limit keys", () => {
  const globalDef = getSettingDef("rate_limit.global_max")!;
  const sensitiveDef = getSettingDef("rate_limit.sensitive_max")!;

  const CASES: { raw: string | undefined; label: string }[] = [
    { raw: "50", label: "an ordinary valid value" },
    { raw: "0", label: "zero — the explicit 'unlimited' value" },
    { raw: "-5", label: "a negative number" },
    { raw: "3.5", label: "a non-integer" },
    { raw: "off", label: "a non-numeric string" },
    { raw: "", label: "an empty string" },
    { raw: undefined, label: "unset" },
  ];

  for (const def of [globalDef, sensitiveDef]) {
    describe(def.key, () => {
      for (const { raw, label } of CASES) {
        it(`agrees on: ${label} (${JSON.stringify(raw)})`, () => {
          const FALLBACK = -1;
          const resolveSecurityLimitAccepted = resolveSecurityLimit(raw, FALLBACK) !== FALLBACK;
          const registryAccepted =
            raw !== undefined && raw.trim() !== "" && zodSchemaFor(def).safeParse(Number(raw)).success;
          expect(registryAccepted, `${def.key}: ${label}`).toBe(resolveSecurityLimitAccepted);
        });
      }
    });
  }
});
