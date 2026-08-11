import { describe, it, expect, afterEach } from "vitest";
import {
  CLEARED_LOCKOUT_STATE,
  LOCKOUT_DEFAULT_MAX_ATTEMPTS,
  LOCKOUT_DEFAULT_MINUTES,
  afterFailedAttempt,
  isLocked,
  isLockoutEnabled,
  lockRemainingMs,
  lockoutConfig,
  lockoutMessage,
  needsClearing,
} from "../src/lib/loginLockout";

/**
 * The SC3 lockout DECISION, tested without a database. The route wiring (does a
 * locked account actually get refused, does a correct password clear the count)
 * is covered in tests-integration/loginLockout.test.ts against the real API —
 * these are the rules that decision is made from.
 */

const NOW = new Date("2026-08-11T09:00:00.000Z");
const CFG = { maxAttempts: 3, lockMs: 15 * 60 * 1000 };

// Every test that touches the env must put it back, or it leaks into the next
// file — the same class of bug as the AppSetting.dispatch_mode leak that once
// failed 148 tests with a misleading message.
const ENV_KEYS = ["LOGIN_LOCKOUT_MAX_ATTEMPTS", "LOGIN_LOCKOUT_MINUTES"] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe("lockout config", () => {
  it("falls back to the safe defaults when unset or malformed", () => {
    delete process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;
    delete process.env.LOGIN_LOCKOUT_MINUTES;
    expect(lockoutConfig().maxAttempts).toBe(LOCKOUT_DEFAULT_MAX_ATTEMPTS);
    expect(lockoutConfig().lockMs).toBe(LOCKOUT_DEFAULT_MINUTES * 60 * 1000);

    // A typo must never silently DISABLE the lockout — same rule the rate
    // limiters use (lib/envLimit), which is why they share the parser.
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "off";
    expect(lockoutConfig().maxAttempts).toBe(LOCKOUT_DEFAULT_MAX_ATTEMPTS);
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "-5";
    expect(lockoutConfig().maxAttempts).toBe(LOCKOUT_DEFAULT_MAX_ATTEMPTS);
  });

  it("honours an explicit value, and 0 means disabled", () => {
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "3";
    expect(lockoutConfig().maxAttempts).toBe(3);
    expect(isLockoutEnabled(lockoutConfig())).toBe(true);

    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "0";
    expect(isLockoutEnabled(lockoutConfig())).toBe(false);
  });

  // ⚠ THE POINT OF READING AT CALL TIME. `sensitiveRateLimiter` freezes its env
  // var into a module constant at import, so nothing that has already loaded the
  // app can change it. If this module ever regressed to that shape, the
  // integration test below it could not drive a real threshold and would be
  // quietly rewritten to assert against a mock instead.
  it("re-reads the environment on every call", () => {
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "3";
    expect(lockoutConfig().maxAttempts).toBe(3);
    process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS = "7";
    expect(lockoutConfig().maxAttempts).toBe(7);
  });
});

describe("lock state", () => {
  it("a null locked_until is not locked", () => {
    expect(isLocked({ failed_login_attempts: 2, locked_until: null }, NOW)).toBe(false);
  });

  it("a lock in the future is active, and reports the time left", () => {
    const state = { failed_login_attempts: 0, locked_until: new Date(NOW.getTime() + 60_000) };
    expect(isLocked(state, NOW)).toBe(true);
    expect(lockRemainingMs(state, NOW)).toBe(60_000);
  });

  // A lock expires on its own. Without this the single admin becomes the
  // availability bottleneck for every driver who fat-fingers a password.
  it("a lock in the past has expired", () => {
    const state = { failed_login_attempts: 0, locked_until: new Date(NOW.getTime() - 1) };
    expect(isLocked(state, NOW)).toBe(false);
    expect(lockRemainingMs(state, NOW)).toBe(0);
  });

  it("the exact expiry instant is not locked", () => {
    const state = { failed_login_attempts: 0, locked_until: new Date(NOW.getTime()) };
    expect(isLocked(state, NOW)).toBe(false);
  });
});

describe("counting failures", () => {
  it("counts up without locking below the threshold", () => {
    const first = afterFailedAttempt({ failed_login_attempts: 0, locked_until: null }, NOW, CFG);
    expect(first).toEqual({ failed_login_attempts: 1, locked_until: null });

    const second = afterFailedAttempt(first, NOW, CFG);
    expect(second).toEqual({ failed_login_attempts: 2, locked_until: null });
  });

  it("locks on the attempt that reaches the threshold", () => {
    const third = afterFailedAttempt({ failed_login_attempts: 2, locked_until: null }, NOW, CFG);
    expect(third.locked_until).toEqual(new Date(NOW.getTime() + CFG.lockMs));
  });

  // The threshold is a COUNT OF ATTEMPTS, not of stored failures: with max 3,
  // the third wrong password locks. An off-by-one here is the difference between
  // the documented number and the enforced one.
  it("allows exactly maxAttempts-1 failures before locking", () => {
    let state = { failed_login_attempts: 0, locked_until: null as Date | null };
    const lockedAfter: number[] = [];
    for (let i = 1; i <= CFG.maxAttempts; i++) {
      state = afterFailedAttempt(state, NOW, CFG);
      if (state.locked_until) lockedAfter.push(i);
    }
    expect(lockedAfter).toEqual([CFG.maxAttempts]);
  });

  // See the module header: carrying the counter over would mean one wrong guess
  // after expiry re-locks instantly, and a user who genuinely forgot their
  // password could never get out.
  it("resets the counter when the lock is applied, so each lock is a fresh budget", () => {
    const locked = afterFailedAttempt({ failed_login_attempts: 2, locked_until: null }, NOW, CFG);
    expect(locked.failed_login_attempts).toBe(0);
  });
});

describe("clearing", () => {
  it("only needs a write when there is something to clear", () => {
    expect(needsClearing({ failed_login_attempts: 0, locked_until: null })).toBe(false);
    expect(needsClearing({ failed_login_attempts: 1, locked_until: null })).toBe(true);
    expect(needsClearing({ failed_login_attempts: 0, locked_until: NOW })).toBe(true);
  });

  it("cleared state is genuinely clear", () => {
    expect(isLocked(CLEARED_LOCKOUT_STATE, NOW)).toBe(false);
    expect(needsClearing(CLEARED_LOCKOUT_STATE)).toBe(false);
  });
});

describe("the message", () => {
  // Rounds UP: a message promising "1 minute" on a 90-second lock sends the user
  // back to a second refusal, which reads as the lockout being broken.
  it("never promises a shorter wait than is enforced", () => {
    expect(lockoutMessage(90_000)).toContain("2 minutes");
    expect(lockoutMessage(60_000)).toContain("1 minute");
    expect(lockoutMessage(1)).toContain("1 minute");
  });

  it("says minute, not minutes, for one", () => {
    expect(lockoutMessage(60_000)).not.toContain("1 minutes");
  });
});
