import { describe, it, expect, afterEach } from "vitest";
import { exceptionsEnabled, demoRoles, demoPassword } from "./featureFlags";

const original = process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS;
afterEach(() => {
  if (original === undefined) delete process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS;
  else process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS = original;
});

describe("exceptionsEnabled — default OFF", () => {
  it("is off when unset", () => {
    delete process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS;
    expect(exceptionsEnabled()).toBe(false);
  });
  it("is off for any value other than the exact string 'true'", () => {
    for (const v of ["", "false", "1", "TRUE", "yes"]) {
      process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS = v;
      expect(exceptionsEnabled()).toBe(false);
    }
  });
  it("is on only for 'true'", () => {
    process.env.EXPO_PUBLIC_FEATURE_EXCEPTIONS = "true";
    expect(exceptionsEnabled()).toBe(true);
  });
});

/**
 * THE DEMO ROLE PICKER MUST BE UNREACHABLE IN PRODUCTION.
 *
 * It signs someone in with no password. On production the driver phones
 * +60100000101…106 belong to REAL employees, so a picker that could render
 * there would hand a stranger a real driver's account. The safety property is
 * not "we set the flag carefully" — it is that the accounts do not exist in
 * this repository, so a production build has nothing to sign in AS.
 *
 * These tests are the proof. Hardcode a fallback phone anywhere in
 * demoRoles() and the first case goes red.
 */
const DEMO_VARS = [
  "EXPO_PUBLIC_DEMO_MODE",
  "EXPO_PUBLIC_DEMO_PASSWORD",
  "EXPO_PUBLIC_DEMO_ADMIN_PHONE",
  "EXPO_PUBLIC_DEMO_REQUESTOR_PHONE",
  "EXPO_PUBLIC_DEMO_DRIVER_PHONE",
] as const;
const saved = DEMO_VARS.map((k) => [k, process.env[k]] as const);
const clearDemo = () => DEMO_VARS.forEach((k) => delete process.env[k]);
afterEach(() => {
  clearDemo();
  for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
});

describe("demoRoles — the picker cannot exist without a demo build", () => {
  it("offers NOTHING on a build with no demo env at all (i.e. production)", () => {
    clearDemo();
    expect(demoRoles()).toEqual([]);
    expect(demoPassword()).toBe("");
  });

  it("offers nothing when the flag is on but no password was supplied", () => {
    clearDemo();
    process.env.EXPO_PUBLIC_DEMO_MODE = "true";
    process.env.EXPO_PUBLIC_DEMO_ADMIN_PHONE = "+60100000001";
    expect(demoRoles()).toEqual([]);
  });

  it("offers nothing when the password is set but the flag is not exactly 'true'", () => {
    clearDemo();
    process.env.EXPO_PUBLIC_DEMO_PASSWORD = "x";
    process.env.EXPO_PUBLIC_DEMO_ADMIN_PHONE = "+60100000001";
    for (const v of ["", "false", "1", "TRUE", "yes"]) {
      process.env.EXPO_PUBLIC_DEMO_MODE = v;
      expect(demoRoles()).toEqual([]);
    }
  });

  it("offers only the roles whose phone was actually configured", () => {
    clearDemo();
    process.env.EXPO_PUBLIC_DEMO_MODE = "true";
    process.env.EXPO_PUBLIC_DEMO_PASSWORD = "x";
    process.env.EXPO_PUBLIC_DEMO_ADMIN_PHONE = "+60100000001";
    process.env.EXPO_PUBLIC_DEMO_DRIVER_PHONE = "+60100000101";
    // No requestor phone → no requestor button, rather than a broken one.
    expect(demoRoles()).toEqual([
      { role: "admin", phone: "+60100000001" },
      { role: "driver", phone: "+60100000101" },
    ]);
  });
});
