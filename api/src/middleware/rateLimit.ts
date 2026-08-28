import rateLimit from "express-rate-limit";
import type { ValueDeterminingMiddleware } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { resolveSecurityLimit } from "../lib/envLimit";
import { effectiveGlobalRateLimitMax, effectiveSensitiveRateLimitMax } from "../lib/rateLimitSettings";

/**
 * Parse an env override into a non-negative integer limit, else the fallback.
 * Blank/invalid values keep the safe default, so a typo can never WEAKEN a
 * limiter; `0` explicitly disables. Exported for unit tests.
 *
 * The rule itself now lives in lib/envLimit so the login lockout parses its own
 * knob identically — see that module for why it is shared rather than copied.
 */
export const resolveRateLimit = resolveSecurityLimit;

// EXPORTED for app.ts (the global limiter's default) and for
// tests/rateLimitSettings.test.ts, which pins settingsRegistry.ts's own
// literal defaults against these — NOT imported directly by
// settingsRegistry.ts, which would create a cycle
// (rateLimit.ts → rateLimitSettings.ts → settingsRegistry.ts → rateLimit.ts).
export const GLOBAL_RATE_LIMIT_DEFAULT = 300;
export const SENSITIVE_RATE_LIMIT_DEFAULT = 10;

/**
 * The bucket a request is counted against: the USER when we can prove who they
 * are, otherwise their IP.
 *
 * ⚠ WHY NOT PER-IP (the bug this replaces). `trust proxy` is on, so the key was
 * the real client IP — and every UWC requestor and admin shares one office
 * egress address. They all counted into ONE 100/min bucket. The admin board
 * polls ~20 req/min per open session on its own, so five idle sessions
 * exhausted it; the request actually refused in the 3 Aug end-to-end run was a
 * driver's `delivered`, the call that records his pay. Raising the number only
 * moves the cliff — it scales with headcount, and hands the same allowance to a
 * single abusive IP. Keying per user is what makes one busy screen unable to
 * throttle a different person.
 *
 * ⚠ THE TOKEN MUST BE VERIFIED, NOT DECODED. `sub` read out of an unverified
 * JWT is attacker-chosen, so anyone could mint an unlimited supply of fresh
 * buckets by inventing user ids — a bigger hole than the one being closed. A
 * token that fails verification is treated as absent and counted against the
 * IP, so a forgery buys nothing.
 *
 * Anonymous traffic stays IP-keyed. Login is separately (and more tightly)
 * covered by `sensitiveRateLimiter` below, so credential stuffing is unaffected
 * by this change.
 *
 * `ip:` / `user:` prefixes keep the two namespaces from ever colliding.
 */
export function rateLimitKey(req: Request): string {
  const header = req.headers?.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const { sub } = verifyAccessToken(header.slice("Bearer ".length));
      if (sub) return `user:${sub}`;
    } catch {
      // Expired, forged, or malformed — fall through to the IP bucket.
    }
  }
  // Matches express-rate-limit 7.5.1's own default keyGenerator, which returns
  // request.ip unmodified (it exports no ipKeyGenerator helper at this version).
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * The GLOBAL limiter. A factory rather than a module-level constant so a test
 * can build one with a small limit instead of firing 300 requests, and so the
 * key rule has exactly one definition.
 *
 * `limit` accepts either a plain number (every existing test — an exact,
 * static threshold with no DB involved) or a function express-rate-limit
 * calls fresh per request (production, since Phase 6, 28 Aug 2026: an
 * admin-editable threshold via lib/rateLimitSettings.ts). Only the STATIC
 * `limit <= 0` case takes the full pass-through bypass — that stays keyed on
 * the value already resolved from the env var at BOOT, deliberately, so
 * `RATE_LIMIT_MAX=0` (the local/CI e2e path) remains true zero-cost: no
 * store, no DB, nothing to await. An admin cannot re-enable the limiter from
 * the DB once the process booted with it off; once running with it on,
 * though, the admin CAN raise, lower, or (via 0) unlimit the live threshold.
 */
export function createGlobalRateLimiter(
  limit: number | ValueDeterminingMiddleware<number>
): RequestHandler {
  if (typeof limit === "number" && limit <= 0) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    // Railway's liveness probe must never consume a user's budget.
    skip: (req) => req.path === "/api/v1/health",
    message: {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please wait a minute and try again.",
      },
    },
  });
}

const SENSITIVE_MAX = resolveRateLimit(process.env.SENSITIVE_RATE_LIMIT_MAX, SENSITIVE_RATE_LIMIT_DEFAULT);

/**
 * Strict per-IP limiter for account-SECURITY endpoints (self password change,
 * admin password reset) — a much tighter budget than the global limiter so a
 * stolen session can't brute-force the current-password check, and a reset
 * endpoint can't be hammered. Default 10/min; `SENSITIVE_RATE_LIMIT_MAX=0`
 * disables it (local e2e, which drives one API from one IP). When disabled it
 * degrades to a pass-through so routes can mount it unconditionally.
 *
 * ⚠ EXPORTED AS A SINGLE STABLE REFERENCE — tests/authRateLimit.test.ts checks
 * it is mounted on /login BY IDENTITY, so this must stay a module-level
 * constant built once, never re-created per request or per settings change.
 * Phase 6 (28 Aug 2026) makes the THRESHOLD it enforces admin-editable
 * without breaking that: when enabled, `limit` is a function express-rate-
 * limit calls fresh each request (short-TTL cached DB read, else SENSITIVE_MAX)
 * rather than a frozen number — the limiter object itself never changes.
 * Disabling stays keyed on the STATIC env value at boot, same reasoning as
 * createGlobalRateLimiter above: the local/CI e2e path must stay zero-cost.
 */
export const sensitiveRateLimiter: RequestHandler =
  SENSITIVE_MAX > 0
    ? rateLimit({
        windowMs: 60 * 1000,
        limit: async () => {
          const effective = await effectiveSensitiveRateLimitMax(SENSITIVE_MAX);
          return effective > 0 ? effective : Number.POSITIVE_INFINITY;
        },
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: {
            code: "RATE_LIMITED",
            message: "Too many attempts. Please wait a minute and try again.",
          },
        },
      })
    : (_req, _res, next) => next();
