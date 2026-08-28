import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { api, auth, loginAs, prisma, resetDb, ADMIN } from "./helpers/harness";
import {
  effectiveGlobalRateLimitMax,
  effectiveSensitiveRateLimitMax,
  resetRateLimitSettingsCache,
} from "../src/lib/rateLimitSettings";

/**
 * Admin-settings Phase 6 (28 Aug 2026) — the resolver + short-TTL cache
 * behind rate_limit.global_max / rate_limit.sensitive_max, driven directly
 * against a real Postgres.
 *
 * This is deliberately NOT a live-request test through the app's mounted
 * limiters — RATE_LIMIT_MAX and SENSITIVE_RATE_LIMIT_MAX are both forced to
 * "0" for the whole integration suite (setup.ts), and app.ts reads that env
 * var once at import to decide whether to build a real limiter at all, so
 * there is no way to exercise the ENABLED path through a real HTTP request in
 * this process. See tests/rateLimitSettings.test.ts's header for the fuller
 * explanation and the other two pieces of the reach proof.
 *
 * What this file DOES prove, for real, against Postgres: an admin's Setting
 * row is what the resolver returns, the cache actually holds a value across
 * calls until it's told to drop it, and the fallback is exactly what a caller
 * passed in when nothing has been saved — the three behaviours the live
 * limiters depend on.
 */
describe("rate-limit settings resolver — DB override, cache, and fallback", () => {
  beforeEach(async () => {
    await resetDb();
    resetRateLimitSettingsCache();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("falls back to the caller's envFallback when no admin Setting exists", async () => {
    expect(await effectiveGlobalRateLimitMax(300)).toBe(300);
    expect(await effectiveSensitiveRateLimitMax(10)).toBe(10);
  });

  it("an admin Setting overrides the fallback", async () => {
    const admin = await loginAs(ADMIN);
    const patch = await api()
      .patch("/api/v1/settings/rate_limit.global_max")
      .set(auth(admin))
      .send({ value: 500 });
    expect(patch.status).toBe(200);
    resetRateLimitSettingsCache(); // a fresh read, not a cached pre-PATCH one

    expect(await effectiveGlobalRateLimitMax(300)).toBe(500);
  });

  it("caches — a PATCH made after the first read is not visible until the cache is cleared", async () => {
    expect(await effectiveGlobalRateLimitMax(300)).toBe(300); // populates the cache

    const admin = await loginAs(ADMIN);
    await api().patch("/api/v1/settings/rate_limit.global_max").set(auth(admin)).send({ value: 999 });

    // Same cache entry as above — the PATCH happened, but this call must
    // still answer from the cache, not hit Postgres again.
    expect(await effectiveGlobalRateLimitMax(300)).toBe(300);

    resetRateLimitSettingsCache();
    expect(await effectiveGlobalRateLimitMax(300)).toBe(999); // now visible
  });

  it("the two settings cache independently", async () => {
    const admin = await loginAs(ADMIN);
    await api()
      .patch("/api/v1/settings/rate_limit.sensitive_max")
      .set(auth(admin))
      .send({ value: 25 });
    resetRateLimitSettingsCache();

    expect(await effectiveGlobalRateLimitMax(300)).toBe(300); // untouched
    expect(await effectiveSensitiveRateLimitMax(10)).toBe(25); // overridden
  });

  it("resetting the Setting restores the fallback", async () => {
    const admin = await loginAs(ADMIN);
    await api().patch("/api/v1/settings/rate_limit.global_max").set(auth(admin)).send({ value: 500 });
    resetRateLimitSettingsCache();
    expect(await effectiveGlobalRateLimitMax(300)).toBe(500);

    await api().delete("/api/v1/settings/rate_limit.global_max").set(auth(admin));
    resetRateLimitSettingsCache();
    expect(await effectiveGlobalRateLimitMax(300)).toBe(300);
  });
});
