import { describe, it, expect } from "vitest";
import { isStrongPassword, PASSWORD_MIN_LENGTH } from "./passwordPolicy";

/**
 * The client copy MUST agree with `api/src/lib/passwordPolicy.ts`. If they
 * drift, the admin reset form either rejects a password the server would take,
 * or accepts one it will refuse with a 400 the admin cannot act on.
 */
describe("password floor (client mirror)", () => {
  it("is 8 characters, matching the server constant", () => {
    // ⚠ If this changes, change PASSWORD_MIN_LENGTH on the server in the SAME
    // commit. Lowered 12 → 11 on 4 Aug 2026 by owner decision so the prod
    // accounts could go back to the seeded password, then 11 → 8 on 11 Aug 2026
    // at the client's request.
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it("accepts a password of the shape the rotation generated", () => {
    expect(isStrongPassword("jY6Xo9nrW4dR4gYD")).toBe(true);
  });

  it("rejects the six-character passwords the reset endpoint used to allow", () => {
    // The specific regression: this was legal until 2 Aug 2026 and would have
    // undone the rotation one account at a time.
    expect(isStrongPassword("abc123")).toBe(false);
    expect(isStrongPassword("Abc123")).toBe(false);
  });

  it("rejects a long password missing a character class", () => {
    expect(isStrongPassword("alllowercase1234")).toBe(false); // no uppercase
    expect(isStrongPassword("ALLUPPERCASE1234")).toBe(false); // no lowercase
    expect(isStrongPassword("NoDigitsInHereAtAll")).toBe(false); // no digit
  });

  // ⚠ INVERTED 4 Aug 2026 (owner decision): `password123` came off the weak
  // list so the seeded default is usable again. The lowercase spelling is still
  // refused, but for want of an uppercase letter rather than by the list.
  it("accepts the seeded default, still refuses its lowercase spelling", () => {
    expect(isStrongPassword("Password123")).toBe(true); // 11 chars, all classes
    expect(isStrongPassword("password123")).toBe(false); // no uppercase
  });

  it("accepts exactly at the boundary, rejects one short", () => {
    expect(isStrongPassword("Abcdefg1")).toBe(true); // 8
    expect(isStrongPassword("Abcdef1")).toBe(false); // 7
  });

  // At a floor of 8 the weak list finally decides something: every entry is 8-9
  // characters, so a floor of 11 or 12 rejected all of them on LENGTH and the
  // list was inert. `Admin123` clears the length and all three character
  // classes, so nothing but the list stands between it and an accepted password.
  it("refuses a known default that clears every other rule", () => {
    expect(isStrongPassword("Admin123")).toBe(false);
  });
});
