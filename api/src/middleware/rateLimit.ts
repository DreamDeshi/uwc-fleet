import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

/**
 * Parse an env override into a non-negative integer limit, else the fallback.
 * Same rule as the global RATE_LIMIT_MAX (app.ts): blank/invalid values keep the
 * safe default, so a typo can never WEAKEN a limiter; `0` explicitly disables.
 * Exported for unit tests.
 */
export function resolveRateLimit(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const SENSITIVE_MAX = resolveRateLimit(process.env.SENSITIVE_RATE_LIMIT_MAX, 10);

/**
 * Strict per-IP limiter for account-SECURITY endpoints (self password change,
 * admin password reset) — a much tighter budget than the global limiter so a
 * stolen session can't brute-force the current-password check, and a reset
 * endpoint can't be hammered. Default 10/min; `SENSITIVE_RATE_LIMIT_MAX=0`
 * disables it (local e2e, which drives one API from one IP). When disabled it
 * degrades to a pass-through so routes can mount it unconditionally.
 */
export const sensitiveRateLimiter: RequestHandler =
  SENSITIVE_MAX > 0
    ? rateLimit({
        windowMs: 60 * 1000,
        limit: SENSITIVE_MAX,
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
