/**
 * SC3 (second half): PER-ACCOUNT login lockout.
 *
 * WHAT THE EXISTING LIMITER DOES NOT COVER. `/login` carries a 10/min per-IP
 * limiter (`sensitiveRateLimiter`, shipped in `5972dff`). That closed the
 * "hundreds of guesses a minute" hole, and it is the wrong shape for the attack
 * that is left: ONE known phone, a handful of guesses a minute, from anywhere,
 * for as long as the attacker cares to wait. The limiter is keyed by IP and
 * resets every minute, so a patient attacker never touches it. Phone IS the
 * login id in this system and the office knows all of them, so the account set
 * is public by construction — the only thing standing between a guessable
 * password and an account is how many guesses you get. This module decides that
 * number.
 *
 * The state lives on User (`failed_login_attempts`, `locked_until`), so a lock
 * survives a restart and applies across every instance — an in-memory counter
 * would reset on each deploy, which on Railway is often enough to matter.
 *
 * ⚠ THE ENV KNOB IS READ AT CALL TIME, NOT AT IMPORT. `sensitiveRateLimiter`
 * freezes `SENSITIVE_RATE_LIMIT_MAX` into a module-level constant, which is why
 * it can only be configured before the module is first imported and cannot be
 * changed by a test that has already loaded the app. Reading per call costs
 * nothing at login frequency and means the integration suite can exercise the
 * REAL path with a real threshold instead of asserting against a mock.
 *
 * ⚠ THIS MUST NOT REPEAT THE `RATE_LIMIT_MAX=0` TRAP. That variable does not
 * disable the auth limiter — a different variable does — and the surprise cost
 * someone a debugging session. So `LOGIN_LOCKOUT_MAX_ATTEMPTS=0` disables the
 * lockout COMPLETELY (no reads, no writes, login behaves exactly as it did
 * before this feature), and it is set to `0` in every place the other two knobs
 * are already set: the integration setup, the CI e2e job, `.env.example` and the
 * e2e README. A local or CI run that disables the limiters gets the lockout
 * disabled alongside them, from the same list, in the same breath.
 */
import { resolveSecurityLimit } from "./envLimit";

/**
 * Failed attempts allowed before the account locks.
 *
 * 10 is chosen against the humans, not the attacker: these are drivers typing a
 * password on a phone in a lorry park, and a lockout that fires on a fat-finger
 * run creates a support call for the one admin. Ten wrong guesses is not a
 * typing accident. It also sits under the 10/min IP limiter, so an attacker on
 * one IP cannot reach the threshold for a second account within the same minute.
 */
export const LOCKOUT_DEFAULT_MAX_ATTEMPTS = 10;

/** How long a triggered lock lasts before it expires on its own. */
export const LOCKOUT_DEFAULT_MINUTES = 15;

export interface LockoutConfig {
  /** 0 = lockout disabled entirely. */
  maxAttempts: number;
  lockMs: number;
}

export function lockoutConfig(): LockoutConfig {
  return {
    maxAttempts: resolveSecurityLimit(
      process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS,
      LOCKOUT_DEFAULT_MAX_ATTEMPTS
    ),
    lockMs:
      resolveSecurityLimit(process.env.LOGIN_LOCKOUT_MINUTES, LOCKOUT_DEFAULT_MINUTES) *
      60 *
      1000,
  };
}

export function isLockoutEnabled(cfg: LockoutConfig): boolean {
  return cfg.maxAttempts > 0;
}

/** The only two User fields this module reads or writes. */
export interface LockoutState {
  failed_login_attempts: number;
  locked_until: Date | null;
}

/**
 * Milliseconds left on an active lock; 0 when not locked.
 *
 * A lock EXPIRES ON ITS OWN — `locked_until` in the past is simply not locked.
 * Without that, every fat-fingered driver becomes a support call, and the one
 * admin becomes the availability bottleneck for the whole fleet. The admin
 * unlock exists to end a lock EARLY, not to be the only way out of one.
 */
export function lockRemainingMs(state: LockoutState, now: Date): number {
  if (!state.locked_until) return 0;
  return Math.max(0, state.locked_until.getTime() - now.getTime());
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return lockRemainingMs(state, now) > 0;
}

/**
 * The state to persist after a wrong password.
 *
 * ⚠ THE COUNTER RESETS WHEN THE LOCK IS APPLIED, deliberately. Carrying it over
 * would mean the single next wrong guess after a lock expires re-locks the
 * account instantly, and a user who genuinely forgot their password would be
 * effectively locked out for good without ever being told why. Each lock
 * therefore starts a fresh budget. The cost is that an attacker gets
 * `maxAttempts` guesses per window rather than one — at 10 per 15 minutes that
 * is 960 guesses a day against a floor of 8 mixed-case-plus-digit characters,
 * which is not a threat; the support burden of the alternative is real.
 */
export function afterFailedAttempt(
  state: LockoutState,
  now: Date,
  cfg: LockoutConfig
): LockoutState {
  const attempts = state.failed_login_attempts + 1;
  if (attempts >= cfg.maxAttempts) {
    return { failed_login_attempts: 0, locked_until: new Date(now.getTime() + cfg.lockMs) };
  }
  return { failed_login_attempts: attempts, locked_until: null };
}

/** Cleared state — written after a correct password, and by the admin unlock. */
export const CLEARED_LOCKOUT_STATE: LockoutState = {
  failed_login_attempts: 0,
  locked_until: null,
};

/**
 * True when the account carries lockout state worth clearing. Lets the success
 * path skip a write on the overwhelmingly common case of someone who simply
 * typed their password correctly.
 */
export function needsClearing(state: LockoutState): boolean {
  return state.failed_login_attempts > 0 || state.locked_until !== null;
}

/**
 * The message a locked-out user sees. Rounds UP, so it never promises a shorter
 * wait than the one being enforced.
 */
export function lockoutMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return (
    `Too many failed sign-in attempts. This account is locked for another ` +
    `${minutes} minute${minutes === 1 ? "" : "s"}. Wait, or ask the office to unlock it.`
  );
}
