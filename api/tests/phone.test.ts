import { describe, it, expect } from "vitest";
import { isNormalizedPhone, normalizePhone } from "../src/lib/phone";

/**
 * ⚠ The number below is SYNTHETIC. This file previously used a real Malaysian
 * mobile — the one from the original bug report — as its fixture, in a public
 * repo. The normalization rule does not care which digits they are.
 *
 * Phone is the login ID, so registration and login must canonicalize the same
 * human input to the same string. The historical bug: the mobile client
 * prepended "+60" without stripping the trunk zero, storing "+600123456789".
 */
describe("normalizePhone", () => {
  it("maps every common way of writing the same number to one canonical form", () => {
    const canonical = "+60123456789";
    for (const input of [
      "0123456789", // local form with trunk zero (the reported bug)
      "123456789", // local form without trunk zero
      "+60123456789", // already canonical
      "+600123456789", // the malformed double-zero the old client produced
      "012-345 6789", // dashes and spaces
    ]) {
      expect(normalizePhone(input), `input: ${input}`).toBe(canonical);
    }
  });

  it("is idempotent on canonical numbers (seeded logins unchanged)", () => {
    for (const seeded of ["+60100000001", "+60199990001", "+60100000106"]) {
      expect(normalizePhone(seeded)).toBe(seeded);
    }
  });

  it("collapses the client-side double prefix (+60 typed into the +60 field)", () => {
    // LoginScreen prepends "+60" to the field's digits, so a user who types
    // the full "+60123456789" into the field submits "+6060123456789".
    expect(normalizePhone("+6060123456789")).toBe("+60123456789");
  });

  it("strips the country code even without a plus", () => {
    expect(normalizePhone("60123456789")).toBe("+60123456789");
  });

  it("handles 10-digit nationals (011-series) and landlines", () => {
    expect(normalizePhone("011-2345 6789")).toBe("+601123456789");
    expect(normalizePhone("+601123456789")).toBe("+601123456789");
    expect(normalizePhone("04-1234567")).toBe("+6041234567");
  });

  it("does not eat a short national number that happens to be near the guard", () => {
    // 8-digit national (shortest valid) with country code: exactly 10 digits.
    expect(normalizePhone("+6062345678")).toBe("+6062345678");
    expect(normalizePhone(normalizePhone("+6062345678"))).toBe("+6062345678");
  });

  it("returns empty string when no digits survive", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("abc")).toBe("");
    expect(normalizePhone("+60")).toBe("");
    expect(normalizePhone("000")).toBe("");
  });
});

describe("isNormalizedPhone", () => {
  it("accepts canonical numbers", () => {
    expect(isNormalizedPhone("+60123456789")).toBe(true);
    expect(isNormalizedPhone("+60100000001")).toBe(true);
    expect(isNormalizedPhone("+6041234567")).toBe(true);
  });

  it("rejects malformed or unnormalized shapes", () => {
    expect(isNormalizedPhone("+600123456789")).toBe(false); // trunk zero kept
    expect(isNormalizedPhone("0123456789")).toBe(false); // no country code
    expect(isNormalizedPhone("+60 123456789")).toBe(false); // whitespace
    expect(isNormalizedPhone("")).toBe(false);
    expect(isNormalizedPhone("+601234")).toBe(false); // too short
    expect(isNormalizedPhone("+60123456789012")).toBe(false); // too long
  });
});
