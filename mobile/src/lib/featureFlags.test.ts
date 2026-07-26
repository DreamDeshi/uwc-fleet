import { describe, it, expect, afterEach } from "vitest";
import { exceptionsEnabled } from "./featureFlags";

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
