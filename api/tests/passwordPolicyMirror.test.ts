import { describe, it, expect } from "vitest";
import * as apiPolicy from "../src/lib/passwordPolicy";
import * as mobilePolicy from "../../mobile/src/lib/passwordPolicy";

/**
 * DRIFT GUARD: api/src/lib/passwordPolicy.ts and mobile/src/lib/passwordPolicy.ts
 * are hand-maintained twins. The server DECIDES (it rejects a weak reset with a
 * 400); the client only predicts that decision so an admin is told what is wrong
 * before a round trip.
 *
 * Both directions of a disagreement are bad, and neither is loud:
 *   client stricter than server → the admin is blocked from setting a password
 *                                 the system would happily accept, with no way
 *                                 to tell whether the rule or the app is wrong.
 *   client looser than server   → the form accepts it, the API 400s, and the
 *                                 admin sees a failure the UI just told them
 *                                 would not happen.
 *
 * Compared BEHAVIOURALLY over a hand-built matrix rather than by source text —
 * the two files legitimately differ (the api side also exposes
 * passwordProblems/passwordProblemMessage for its error strings, which the
 * client has no use for).
 *
 * ⚠ THE FLOOR IS NOT COSMETIC. It is the strength the eight seeded prod accounts
 * were rotated to on 2 Aug 2026; the admin reset path accepted six characters
 * until the same day, which meant a reset could undo that rotation one account
 * at a time. If these two drift, that hole reopens on one side only.
 */

const CASES: { pw: string; why: string }[] = [
  // — Accepted —
  { pw: "jY6Xo9nrW4dR4gYD", why: "the shape the prod rotation actually generated" },
  { pw: "Abcdefghij1k", why: "exactly at the 12-char boundary" },
  { pw: "Tr0ubadour&3xtra", why: "symbols are allowed, not required" },
  { pw: "MixedCase12345678", why: "comfortably long" },

  // — Length —
  { pw: "Abcdefghij1", why: "one character short of the floor" },
  { pw: "Ab1", why: "far too short" },
  { pw: "", why: "empty" },

  // — Missing a character class —
  { pw: "alllowercase1234", why: "no uppercase" },
  { pw: "ALLUPPERCASE1234", why: "no lowercase" },
  { pw: "NoDigitsInHereAtAll", why: "no digit" },
  { pw: "1234567890123456", why: "digits only" },

  // — Known defaults, including the one this project shipped with —
  { pw: "Password123", why: "the seeded default, correct classes" },
  { pw: "password123", why: "the seeded default, lowercased" },
  { pw: "PASSWORD123", why: "the seeded default, uppercased" },
  { pw: "changeme", why: "known default" },
  { pw: "qwerty123", why: "known default" },
  { pw: "12345678", why: "known default" },

  // — Near misses around the weak list —
  { pw: "Password1234", why: "12 chars, NOT the exact default string" },
  { pw: "MyPassword123", why: "contains a default as a substring only" },

  // — Unicode / whitespace, where two regexes can quietly disagree —
  { pw: "Ábcdefghij1k", why: "accented uppercase" },
  { pw: "Abcdefg hij1k", why: "contains a space" },
  { pw: "密码密码密码密码密码密码", why: "no ASCII classes at all" },
];

describe("password policy: api ↔ mobile mirror", () => {
  it("exports the same minimum length", () => {
    expect(mobilePolicy.PASSWORD_MIN_LENGTH).toBe(apiPolicy.PASSWORD_MIN_LENGTH);
    // Pinned to the literal too: if someone lowers BOTH sides in one commit the
    // comparison above still passes, and the rotation floor would drop silently.
    expect(apiPolicy.PASSWORD_MIN_LENGTH).toBe(12);
  });

  it("agrees on every case in the matrix", () => {
    const disagreements = CASES.filter(
      ({ pw }) => apiPolicy.isStrongPassword(pw) !== mobilePolicy.isStrongPassword(pw)
    ).map(({ pw, why }) => `${JSON.stringify(pw)} (${why}): api=${apiPolicy.isStrongPassword(pw)} mobile=${mobilePolicy.isStrongPassword(pw)}`);

    expect(
      disagreements,
      ["", "The two copies of the password floor disagree:", ...disagreements.map((d) => `  ${d}`), ""].join("\n")
    ).toEqual([]);
  });

  // The matrix is only worth something if it contains both verdicts — a list of
  // all-rejects would pass while proving nothing about what is accepted.
  it("the matrix exercises both outcomes", () => {
    const verdicts = CASES.map(({ pw }) => apiPolicy.isStrongPassword(pw));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("rejects the seeded default whatever its casing", () => {
    for (const pw of ["Password123", "password123", "PASSWORD123", "PaSsWoRd123"]) {
      expect(apiPolicy.isStrongPassword(pw), pw).toBe(false);
      expect(mobilePolicy.isStrongPassword(pw), pw).toBe(false);
    }
  });
});
