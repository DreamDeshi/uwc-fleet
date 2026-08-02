import { describe, it, expect } from "vitest";
import { isStrongPassword, PASSWORD_MIN_LENGTH } from "./passwordPolicy";

/**
 * The client copy MUST agree with `api/src/lib/passwordPolicy.ts`. If they
 * drift, the admin reset form either rejects a password the server would take,
 * or accepts one it will refuse with a 400 the admin cannot act on.
 */
describe("password floor (client mirror)", () => {
  it("is 12 characters, matching the server constant", () => {
    // ⚠ If this changes, change PASSWORD_MIN_LENGTH on the server in the SAME
    // commit — the value is what the prod rotation was actually held to.
    expect(PASSWORD_MIN_LENGTH).toBe(12);
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

  it("rejects the seeded default even though it has the right classes", () => {
    // Password123 clears length? No — but the lowercased form is on the weak
    // list regardless, and padding it must not sneak it through.
    expect(isStrongPassword("Password123")).toBe(false);
    expect(isStrongPassword("password123")).toBe(false);
  });

  it("accepts exactly at the boundary, rejects one short", () => {
    expect(isStrongPassword("Abcdefghij1k")).toBe(true); // 12
    expect(isStrongPassword("Abcdefghij1")).toBe(false); // 11
  });
});
