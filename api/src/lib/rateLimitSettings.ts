import { getEffectiveSetting } from "./settingsRegistry";

/**
 * Admin-settings Phase 6 (28 Aug 2026) — rate_limit.global_max /
 * rate_limit.sensitive_max.
 *
 * ⚠ THE ONE PLACE A SETTING IS CACHED RATHER THAN READ FRESH PER CALL.
 * Every other phase resolves its setting once per REQUEST (a route handler,
 * or a background sweep's own tick) — a cheap, bounded frequency. The rate
 * limiters are different: express-rate-limit invokes its `limit` callback on
 * EVERY request across (for the global limiter) the entire API surface, so a
 * raw `await getEffectiveSetting(...)` here would multiply Postgres load by
 * the app's whole request volume. A short-TTL cache keeps the DB read to
 * roughly once per TTL window, however busy the API gets.
 *
 * Same delegation shape as lib/securitySettings.ts: falls back to
 * `envFallback` (the value `resolveSecurityLimit` already computed once at
 * boot from the env var) rather than duplicating that parsing through the
 * registry's generic env-var mechanism, for the same drift-risk reason
 * documented there.
 *
 * ⚠ MUST NEVER THROW OR HANG. Every other phase's resolver runs inside a
 * single route or sweep, where a DB failure was already going to fail that
 * one request/tick anyway. This one runs inside a middleware mounted on the
 * WHOLE app (the global limiter) — an unhandled rejection here would make an
 * unrelated database hiccup take down every request the API serves, which is
 * a far worse outage than the feature is worth. A try/catch ALONE is not
 * enough: found live while wiring this up — with the Docker test DB stopped,
 * a REAL, unrelated unit test (tests/incentiveRules.test.ts, which boots the
 * real `app`) hung for the full 5s test timeout on its very first request,
 * because `getEffectiveSetting`'s underlying Postgres connection attempt
 * never SETTLED at all (neither resolved nor rejected) within that window —
 * a catch block only helps once a promise settles. `withTimeout` below races
 * it against a short clock instead, so an unreachable or slow DB degrades to
 * the fallback in DB_TIMEOUT_MS, not "however long Postgres takes to give up".
 */
const CACHE_TTL_MS = 5000;
const DB_TIMEOUT_MS = 300;

interface CacheEntry {
  value: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function cachedEffectiveLimit(key: string, envFallback: number, now: number): Promise<number> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const setting = await withTimeout(getEffectiveSetting(key), DB_TIMEOUT_MS);
    const value = setting.source === "db" ? (setting.value as number) : envFallback;
    cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    console.error(`rate-limit setting "${key}" lookup failed or timed out, falling back to ${envFallback}:`, err);
    // Cache the fallback too, briefly, so an outage doesn't retry the DB on
    // every single request until it recovers.
    cache.set(key, { value: envFallback, expiresAt: now + CACHE_TTL_MS });
    return envFallback;
  }
}

export async function effectiveGlobalRateLimitMax(envFallback: number): Promise<number> {
  return cachedEffectiveLimit("rate_limit.global_max", envFallback, Date.now());
}

export async function effectiveSensitiveRateLimitMax(envFallback: number): Promise<number> {
  return cachedEffectiveLimit("rate_limit.sensitive_max", envFallback, Date.now());
}

/** Test hook: clear the cache between test cases so one test's PATCH is visible to the next call. */
export function resetRateLimitSettingsCache(): void {
  cache.clear();
}
