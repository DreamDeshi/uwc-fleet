import { describe, it, expect, afterEach } from "vitest";
import * as apiFlags from "../src/lib/featureFlags";
import * as mobileFlags from "../../mobile/src/lib/featureFlags";

/**
 * DRIFT GUARD: api/src/lib/featureFlags.ts and mobile/src/lib/featureFlags.ts.
 *
 * ── WHAT IS AND IS NOT COMPARABLE HERE ─────────────────────────────────────
 *
 * These twins read DIFFERENT variables ON PURPOSE — `FEATURE_EXCEPTIONS` on the
 * server, `EXPO_PUBLIC_FEATURE_EXCEPTIONS` in the bundle (the EXPO_PUBLIC_
 * prefix is what makes it inlined at build). Comparing their VALUES would be
 * meaningless, and a mirror test that did so would be worse than none: it would
 * fail on a correct configuration.
 *
 * What must not drift is the PARSING RULE. Both files promise the same thing in
 * their own words — "All flags DEFAULT OFF: an unset / blank / non-'true' value
 * is disabled", "only the exact string 'true' enables a flag". So each function
 * is fed the same inputs through its OWN variable, and the answers must match.
 *
 * ── WHY IT MATTERS MORE THAN IT LOOKS ──────────────────────────────────────
 *
 * The two halves gate the same feature from opposite ends: while a flag is off
 * the API 404s the routes AND the client hides the surface. If one side started
 * accepting "1", "TRUE" or any truthy string, the client would render a button
 * whose endpoint returns 404 — or hide a feature that is live. That failure is
 * silent and looks like a broken feature rather than a broken flag, which is
 * exactly how the OTA native-config bug read when every driver and requestor
 * map died while the admin map kept working.
 *
 * Both flags are OFF in production today, so this guards the flip, which is the
 * moment it is most needed and least tested.
 */

const API_VARS: Record<string, string> = {
  exceptionsEnabled: "FEATURE_EXCEPTIONS",
  changeRequestsEnabled: "FEATURE_CHANGE_REQUESTS",
};
const MOBILE_VARS: Record<string, string> = {
  exceptionsEnabled: "EXPO_PUBLIC_FEATURE_EXCEPTIONS",
  changeRequestsEnabled: "EXPO_PUBLIC_FEATURE_CHANGE_REQUESTS",
};

/** Everything a real .env or CI export can produce, plus the near-misses. */
const VALUES: (string | undefined)[] = [
  "true",
  undefined, // unset
  "",
  " ",
  "false",
  "TRUE",
  "True",
  "1",
  "0",
  "yes",
  "on",
  "true ",
  " true",
  "truthy",
];

const api = apiFlags as unknown as Record<string, () => boolean>;
const mobile = mobileFlags as unknown as Record<string, () => boolean>;

const setVar = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  for (const v of [...Object.values(API_VARS), ...Object.values(MOBILE_VARS)]) delete process.env[v];
});

describe("featureFlags.ts api↔mobile drift guard", () => {
  it("both modules export the same flag functions", () => {
    expect(Object.keys(MOBILE_VARS).sort()).toEqual(Object.keys(API_VARS).sort());
    for (const name of Object.keys(API_VARS)) {
      expect(typeof api[name], `api.${name}`).toBe("function");
      expect(typeof mobile[name], `mobile.${name}`).toBe("function");
    }
  });

  it("the same input decides the same answer on both sides", () => {
    const disagreements: string[] = [];
    for (const name of Object.keys(API_VARS)) {
      for (const value of VALUES) {
        setVar(API_VARS[name], value);
        setVar(MOBILE_VARS[name], value);
        const a = api[name]();
        const m = mobile[name]();
        if (a !== m) {
          disagreements.push(`${name}(${JSON.stringify(value)}): api=${a} mobile=${m}`);
        }
      }
    }
    expect(
      disagreements,
      [
        "",
        "The server and the client disagree about whether a flag is ON:",
        ...disagreements.map((d) => `  ${d}`),
        "",
        "One side renders a surface the other 404s. Both must accept ONLY the",
        "exact string \"true\".",
        "",
      ].join("\n")
    ).toEqual([]);
  });

  it('ONLY the exact string "true" enables, on both sides', () => {
    // The rule itself, stated once rather than inferred from the agreement
    // above — two sides can agree and both be wrong.
    for (const name of Object.keys(API_VARS)) {
      for (const value of VALUES) {
        setVar(API_VARS[name], value);
        setVar(MOBILE_VARS[name], value);
        const expected = value === "true";
        expect(api[name](), `api ${name}(${JSON.stringify(value)})`).toBe(expected);
        expect(mobile[name](), `mobile ${name}(${JSON.stringify(value)})`).toBe(expected);
      }
    }
  });

  it("a flag is OFF when its variable is absent entirely", () => {
    // The production state today, and the one a typo must never change.
    for (const v of [...Object.values(API_VARS), ...Object.values(MOBILE_VARS)]) delete process.env[v];
    for (const name of Object.keys(API_VARS)) {
      expect(api[name](), `api ${name}`).toBe(false);
      expect(mobile[name](), `mobile ${name}`).toBe(false);
    }
  });
});
