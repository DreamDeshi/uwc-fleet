import { describe, it, expect } from "vitest";

import {
  EXPIRY_SKEW_SECONDS,
  accessTokenExpiry,
  accessTokenUsable,
  shouldClearEnrolment,
  unlockDecision,
  passwordLoginClearsEnrolment,
  unlockFailureKey,
} from "./biometricUnlock";

/**
 * The unlock DECISION — the half of biometrics that has nothing to do with
 * fingerprints.
 *
 * ⚠ The offline rule is an OWNER RULING that overrode the original brief, so
 * these cases exist to stop it being "tightened" back by someone reading only
 * the security half. Unconditional server validation locks a driver out in a
 * dead spot — at the one moment he cannot fix it, with the password path
 * equally dead — which trades a stopped delivery for a UX annoyance.
 */

const NOW = Date.UTC(2026, 7, 12, 10, 0, 0); // 2026-08-12T10:00:00Z

/** A JWT with the given `exp`, unsigned — only the payload is ever read. */
function jwt(expSeconds: number | null): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(expSeconds === null ? { sub: "u1" } : { sub: "u1", exp: expSeconds })}.sig`;
}

const inSeconds = (s: number) => Math.floor(NOW / 1000) + s;

describe("accessTokenExpiry — decoded, never trusted", () => {
  it("reads exp out of a JWT payload", () => {
    expect(accessTokenExpiry(jwt(inSeconds(900)))).toBe(inSeconds(900));
  });

  it("returns null for anything that is not a JWT with an expiry", () => {
    // Null rather than a guess: every one of these must fall through to
    // "refuse", because entering on an unknown token is the case that ends in
    // an unexplained bounce to the login screen.
    for (const bad of [null, "", "not.a.jwt", "only.two", jwt(null), "a.b.c"]) {
      expect(accessTokenExpiry(bad)).toBeNull();
    }
  });
});

describe("accessTokenUsable — the offline boundary", () => {
  it("accepts a token with real time left", () => {
    expect(accessTokenUsable(jwt(inSeconds(600)), NOW)).toBe(true);
  });

  it("REFUSES a token inside the skew window, not just an expired one", () => {
    // Entering on 4 seconds of validity means the first request 401s and the
    // driver is bounced anyway — which looks exactly like the unexplained
    // logout this design exists to avoid. Refuse before the fingerprint.
    expect(accessTokenUsable(jwt(inSeconds(EXPIRY_SKEW_SECONDS - 1)), NOW)).toBe(false);
    expect(accessTokenUsable(jwt(inSeconds(EXPIRY_SKEW_SECONDS + 1)), NOW)).toBe(true);
  });

  it("refuses an already-expired token and an unreadable one alike", () => {
    expect(accessTokenUsable(jwt(inSeconds(-1)), NOW)).toBe(false);
    expect(accessTokenUsable(null, NOW)).toBe(false);
  });
});

describe("unlockDecision — the owner's three cases, verbatim", () => {
  it("ONLINE → always validate with the server, whatever the token says", () => {
    // Even a token with hours left: online, the server gets the final word, so
    // a disabled driver or a session taken over on another phone is caught.
    expect(unlockDecision({ online: true, accessToken: jwt(inSeconds(3600)), now: NOW })).toEqual({
      action: "validate",
    });
    expect(unlockDecision({ online: true, accessToken: jwt(inSeconds(-1)), now: NOW })).toEqual({
      action: "validate",
    });
  });

  it("OFFLINE with an unexpired token → entry, exactly like today's resume", () => {
    expect(unlockDecision({ online: false, accessToken: jwt(inSeconds(600)), now: NOW })).toEqual({
      action: "enter",
    });
  });

  it("OFFLINE with an expired token → no entry, the boundary the app already had", () => {
    // Not a new restriction: an expired token cannot be refreshed without the
    // network either, so this is where the app already stops.
    expect(unlockDecision({ online: false, accessToken: jwt(inSeconds(-60)), now: NOW })).toEqual({
      action: "refuse",
      reason: "offline_expired",
    });
  });

  it("OFFLINE with no token at all → no entry", () => {
    expect(unlockDecision({ online: false, accessToken: null, now: NOW })).toEqual({
      action: "refuse",
      reason: "offline_expired",
    });
  });
});

describe("failures explain themselves, and only the SERVER un-enrols", () => {
  it("every failure has its own message key", () => {
    // "Login failed" is the outcome the pre-check was meant to prevent and
    // could not; the explanation is what actually fixes it.
    const keys = (["biometric_failed", "offline_expired", "session_rejected", "unavailable"] as const).map(
      unlockFailureKey
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys).toContain("unlock.failure.session_rejected");
  });

  it("clears the enrolment ONLY when the server rejected the session", () => {
    expect(shouldClearEnrolment("session_rejected")).toBe(true);
    // ⚠ The three that must NOT un-enrol. Making a driver re-enrol because he
    // walked into a lift, or fat-fingered the prompt, is how a feature gets
    // switched off and stays off.
    expect(shouldClearEnrolment("biometric_failed")).toBe(false);
    expect(shouldClearEnrolment("offline_expired")).toBe(false);
    expect(shouldClearEnrolment("unavailable")).toBe(false);
  });
});

/**
 * ⚠ THE SHARED-HANDSET RULE — DG-D4's reasoning at a new door.
 *
 * Drivers share phones. An enrolment that outlives the enrolled user puts that
 * user's session one thumb away from whoever is next holding the device, which
 * is the same failure DG-D4 fixed for queued PODs and per-driver storage keys.
 */
describe("passwordLoginClearsEnrolment", () => {
  it("clears when a DIFFERENT user signs in with a password", () => {
    expect(passwordLoginClearsEnrolment("driver-a", "driver-b")).toBe(true);
  });

  it("leaves the enrolled user's own password login alone", () => {
    // Signing in with a password is not opting out. Wiping here would make the
    // feature feel broken every time a driver chose the password path.
    expect(passwordLoginClearsEnrolment("driver-a", "driver-a")).toBe(false);
  });

  it("does nothing when the device was never enrolled", () => {
    expect(passwordLoginClearsEnrolment(null, "driver-b")).toBe(false);
  });
});
