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
 * ⚠ THE FLOOR IS NOT COSMETIC. The admin reset path accepted six characters
 * until 2 Aug 2026, which meant a reset could undo a rotation one account at a
 * time. If these two drift, that hole reopens on one side only.
 *
 * ⚠ On 4 Aug 2026 the owner lowered the floor to 11 and dropped `password123`
 * from the weak list so the prod accounts could return to the seeded password.
 * On 11 Aug 2026 the client asked for 8. The mirror guarantee is unchanged; only
 * the verdicts moved. Do not raise either value back without asking.
 *
 * ⚠ THE FLOOR MOVING TO 8 PUT THE WEAK LIST BACK TO WORK. Every entry in
 * WEAK_PASSWORDS is 8-9 characters, so while the floor was 11 or 12 the LENGTH
 * rule rejected all of them first and the list itself decided nothing. At 8 it
 * is load-bearing again — `Admin123` below is the case that proves it, since it
 * clears the length and all three character classes and is refused by the list
 * alone.
 */

const CASES: { pw: string; why: string }[] = [
  // — Accepted —
  { pw: "jY6Xo9nrW4dR4gYD", why: "the shape the 2 Aug prod rotation generated" },
  { pw: "Abcdefg1", why: "exactly at the 8-char boundary" },
  { pw: "Abcdefghij1", why: "the old 11-char boundary — still fine, just no longer the edge" },
  { pw: "Tr0ubadour&3xtra", why: "symbols are allowed, not required" },
  { pw: "MixedCase12345678", why: "comfortably long" },
  { pw: "Password123", why: "the seeded default — LEGAL since 4 Aug 2026" },
  { pw: "Abcdefghi1", why: "10 chars — was below the floor until 11 Aug 2026, now accepted" },

  // — Length —
  { pw: "Abcdef1", why: "7 — one character short of the floor" },
  { pw: "Ab1", why: "far too short" },
  { pw: "", why: "empty" },

  // — Missing a character class —
  { pw: "alllowercase1234", why: "no uppercase" },
  { pw: "ALLUPPERCASE1234", why: "no lowercase" },
  { pw: "NoDigitsInHereAtAll", why: "no digit" },
  { pw: "1234567890123456", why: "digits only" },

  // — Known defaults still on the weak list. At a floor of 8 these are no longer
  //   rejected on length, so the list is doing real work for the first time. —
  { pw: "changeme", why: "known default" },
  { pw: "qwerty123", why: "known default" },
  { pw: "12345678", why: "known default" },
  { pw: "Admin123", why: "known default, clears length AND all three classes — only the weak list refuses it" },

  // — The seeded default's other spellings. These are refused by the CHARACTER
  //   CLASS rules, not by the weak list, which no longer contains it. They are
  //   the reason removing `password123` did not open a case-insensitive hole.
  { pw: "password123", why: "seeded default lowercased — no uppercase" },
  { pw: "PASSWORD123", why: "seeded default uppercased — no lowercase" },

  // — Near misses around the weak list —
  { pw: "Password1234", why: "the 12-char stand-in used while the floor was 12" },
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
    // 8 since 11 Aug 2026 (client request) — see api/src/lib/passwordPolicy.ts.
    expect(apiPolicy.PASSWORD_MIN_LENGTH).toBe(8);
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

  // ⚠ INVERTED 4 Aug 2026 (owner decision). This used to assert that every
  // casing of the seeded default was refused. `password123` is no longer on the
  // weak list, so the mixed-case spellings are now LEGAL — that is the point of
  // the change, not a regression. What still has to hold is that both twins
  // agree, and that the all-one-case spellings stay refused on class grounds.
  it("accepts the seeded default in mixed case, still refuses the single-case spellings", () => {
    for (const pw of ["Password123", "PaSsWoRd123"]) {
      expect(apiPolicy.isStrongPassword(pw), pw).toBe(true);
      expect(mobilePolicy.isStrongPassword(pw), pw).toBe(true);
    }
    for (const pw of ["password123", "PASSWORD123"]) {
      expect(apiPolicy.isStrongPassword(pw), pw).toBe(false);
      expect(mobilePolicy.isStrongPassword(pw), pw).toBe(false);
    }
  });
});
