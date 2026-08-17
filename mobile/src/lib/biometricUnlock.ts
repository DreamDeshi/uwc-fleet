/**
 * BIOMETRIC UNLOCK — the decision, kept pure and away from the UI.
 *
 * The device biometric NEVER grants access. It unlocks a stored REFRESH TOKEN,
 * and the server decides. That is the whole shape of this feature: a fingerprint
 * proves who is holding the phone, not that the account is still allowed in.
 *
 * ── THE OFFLINE RULE (owner ruling, 12 Aug 2026) ─────────────────────────────
 *
 * The first draft of the brief said server validation was unconditional. It was
 * corrected, and the reasoning is worth keeping because it is the kind of rule
 * that gets "tightened" back by someone reading only the security half:
 *
 *   "Offline lockout is worse than the problem it solves. Today a driver in a
 *    dead spot resumes from stored tokens and keeps working; unconditional
 *    validation locks him out at the one moment he cannot fix it — with the
 *    password path equally dead, because that needs the network too. That is a
 *    delivery stopped, against a UX annoyance."
 *
 * So:
 *   ONLINE                        → unlock, POST /auth/refresh, and only a fresh
 *                                   pair shows the app as signed in.
 *   OFFLINE, access token valid   → entry, exactly like today's resume.
 *                                   Validated at the first successful request.
 *   OFFLINE, access token expired → no entry. ⚠ This is not a new boundary: it
 *                                   is the SAME one the app already has, since
 *                                   an expired token cannot be refreshed without
 *                                   the network either.
 *
 * ⚠ WHAT THE PRE-CHECK WAS PROTECTING AGAINST WAS NEVER THE PRE-CHECK'S JOB.
 * The fear was "my fingerprint worked and it logged me out with no explanation".
 * What fixes that is the EXPLANATION — see `UNLOCK_REJECTED_REASON` — not a gate
 * that also locks out the offline case. Keep the message, drop the gate.
 */

/** Why an unlock attempt ended where it did. Drives what the driver is told. */
export type UnlockDecision =
  | { action: "validate" } // online: ask the server before letting anyone in
  | { action: "enter" } // offline with an unexpired access token
  | { action: "refuse"; reason: "offline_expired" };

/**
 * Seconds of slack when judging expiry offline.
 *
 * A token about to expire is treated as expired: entering on 4 seconds of
 * validity means the first request 401s and the driver is bounced to the login
 * screen anyway, which looks exactly like the unexplained logout this design is
 * trying to avoid. Better to refuse before the fingerprint than after it.
 */
export const EXPIRY_SKEW_SECONDS = 30;

/**
 * `exp` (seconds since epoch) out of a JWT payload, or null if it is not a JWT
 * or carries no expiry.
 *
 * ⚠ DECODED, NOT VERIFIED, and that is fine here: this only decides whether to
 * ATTEMPT offline entry. Every actual request is still authenticated by the
 * server, so a forged token buys entry to a shell that can do nothing. Verifying
 * would need the signing key on the device, which is strictly worse.
 */
export function accessTokenExpiry(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64. atob exists on web and in Hermes.
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      decodeURIComponent(
        atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
          .split("")
          .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
          .join("")
      )
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** Is the stored access token still good enough to enter on, offline? */
export function accessTokenUsable(token: string | null, nowMs: number = Date.now()): boolean {
  const exp = accessTokenExpiry(token);
  if (exp === null) return false; // unparseable or no expiry → do not guess
  return exp - EXPIRY_SKEW_SECONDS > nowMs / 1000;
}

/**
 * What should happen once the biometric prompt has SUCCEEDED?
 *
 * Called only after `authenticateAsync` resolved true — this function never
 * decides whether the person is who they say they are, only what to do about
 * the session now that the device says they are.
 */
export function unlockDecision(params: {
  online: boolean;
  accessToken: string | null;
  now?: number;
}): UnlockDecision {
  if (params.online) return { action: "validate" };
  if (accessTokenUsable(params.accessToken, params.now)) return { action: "enter" };
  return { action: "refuse", reason: "offline_expired" };
}

/**
 * Every way an unlock can end with the driver NOT signed in — each one has to
 * name itself on screen.
 *
 * `session_rejected` is the one that matters: the server refused the stored
 * refresh token, which in practice means the driver signed in on another phone
 * (the API rotates refresh tokens, so the older one dies) or an admin disabled
 * the account. Telling him "signed in on another phone — sign in again here,
 * and pushes now go to the other phone" is the difference between a system that
 * looks broken and one that looks strict.
 */
export type UnlockFailure =
  | "biometric_failed" // the prompt was cancelled or did not match
  | "offline_expired" // offline and the stored token has aged out
  | "session_rejected" // the server said no — enrolment is cleared
  | "unavailable"; // hardware or OS enrolment disappeared under us

/** i18n key for the on-screen explanation. Never a bare "login failed". */
export function unlockFailureKey(failure: UnlockFailure): string {
  return `unlock.failure.${failure}`;
}

/**
 * Does a rejection clear the enrolment?
 *
 * Only when the SERVER refused. A cancelled prompt or a dead network must never
 * un-enrol a device: the credential is still good, and making a driver re-enrol
 * because he walked into a lift is how a feature gets switched off and stays off.
 */
export function shouldClearEnrolment(failure: UnlockFailure): boolean {
  return failure === "session_rejected";
}

/**
 * Should a password login by `userId` wipe an existing enrolment?
 *
 * ⚠ THE SHARED-HANDSET RULE — DG-D4's reasoning at a new door. Drivers share
 * phones, so an enrolment that outlives the enrolled user leaves that user's
 * session one thumb away from whoever is next holding the device. A DIFFERENT
 * user signing in with a password is the signal that has happened.
 *
 * Lives here rather than beside the SecureStore code because this file imports
 * no React Native and can therefore be unit-tested; the module that touches the
 * native side cannot be collected by vitest at all.
 */
export function passwordLoginClearsEnrolment(
  enrolledFor: string | null,
  loggingIn: string
): boolean {
  return enrolledFor !== null && enrolledFor !== loggingIn;
}
