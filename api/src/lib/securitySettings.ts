import { getEffectiveSetting } from "./settingsRegistry";
import { lockoutConfig, type LockoutConfig } from "./loginLockout";

/**
 * Admin-settings Phase 5 — the login-lockout config in effect right now.
 *
 * ⚠ Deliberately does NOT go through the registry's generic env-var
 * resolution the way Phases 1-4's settings do. `loginLockout.ts` already has
 * a NAMED, SHARED, security-reviewed env parser (`envLimit.ts`'s
 * `resolveSecurityLimit`) — its own header exists specifically to stop two
 * copies of a SECURITY default's parsing rule from drifting apart (the
 * `RATE_LIMIT_MAX=0` trap it names is exactly that kind of drift). Building a
 * SECOND, independently-coded env+default resolver for the same two env vars
 * via the registry's generic mechanism would be exactly the risk that file
 * was written to prevent — so this delegates to `lockoutConfig()` for the
 * env+default layer instead of duplicating it, and only overrides with an
 * admin's Setting row when one has actually been saved (`source === "db"`).
 *
 * This also keeps `lockoutConfig()` itself genuinely REACHED in production
 * (called on every login where no admin override exists — i.e. almost
 * always) rather than becoming a function nothing calls once this file
 * shipped.
 */
export async function effectiveLockoutConfig(): Promise<LockoutConfig> {
  const [maxAttemptsSetting, lockMinutesSetting] = await Promise.all([
    getEffectiveSetting("security.login_lockout_max_attempts"),
    getEffectiveSetting("security.login_lockout_minutes"),
  ]);
  const envDefault = lockoutConfig();
  return {
    maxAttempts:
      maxAttemptsSetting.source === "db" ? (maxAttemptsSetting.value as number) : envDefault.maxAttempts,
    lockMs:
      lockMinutesSetting.source === "db"
        ? (lockMinutesSetting.value as number) * 60 * 1000
        : envDefault.lockMs,
  };
}
