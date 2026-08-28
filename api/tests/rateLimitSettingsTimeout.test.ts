import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE BUG THIS FILE EXISTS FOR (found live, 28 Aug 2026, while building Phase
 * 6 — never shipped to production).
 *
 * With the Docker test DB stopped, an UNRELATED unit test
 * (tests/incentiveRules.test.ts, which boots the real `app`) hung for the
 * full 5-second test timeout on its very first request. The cause: the
 * global rate limiter's `limit` callback awaited `getEffectiveSetting(...)`,
 * whose underlying Postgres connection attempt never SETTLED at all within
 * that window — neither resolved nor rejected. A try/catch does nothing for
 * a promise that never settles; only a race against a clock bounds it. This
 * pins that bound directly, by mocking a DB call that hangs FOREVER and
 * proving the resolver still answers.
 *
 * Separate file from tests/rateLimitSettings.test.ts on purpose: this one
 * mocks the ENTIRE settingsRegistry module, which would break that file's
 * real getSettingDef/zodSchemaFor cross-checks if combined.
 */
vi.mock("../src/lib/settingsRegistry", () => ({
  getEffectiveSetting: vi.fn(),
}));

import { getEffectiveSetting } from "../src/lib/settingsRegistry";
import {
  effectiveGlobalRateLimitMax,
  effectiveSensitiveRateLimitMax,
  resetRateLimitSettingsCache,
} from "../src/lib/rateLimitSettings";

const getEffectiveSettingMock = vi.mocked(getEffectiveSetting);

describe("rateLimitSettings — must never hang the app on a slow or unreachable DB", () => {
  beforeEach(() => {
    resetRateLimitSettingsCache();
    getEffectiveSettingMock.mockReset();
  });

  it("falls back to envFallback within a bounded time when the DB call never settles", async () => {
    getEffectiveSettingMock.mockImplementation(() => new Promise(() => {})); // hangs forever
    const start = Date.now();
    const value = await effectiveGlobalRateLimitMax(300);
    const elapsedMs = Date.now() - start;
    expect(value).toBe(300);
    // Bounded by DB_TIMEOUT_MS (300ms), not "however long Postgres takes to
    // give up" — generous headroom so this isn't flaky on a loaded CI box.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("falls back to envFallback when the DB call rejects outright", async () => {
    getEffectiveSettingMock.mockRejectedValue(new Error("connection refused"));
    expect(await effectiveSensitiveRateLimitMax(10)).toBe(10);
  });

  it("recovers once the DB answers again, after the cache is cleared", async () => {
    getEffectiveSettingMock.mockImplementation(() => new Promise(() => {}));
    expect(await effectiveGlobalRateLimitMax(300)).toBe(300); // times out, falls back

    resetRateLimitSettingsCache();
    getEffectiveSettingMock.mockResolvedValue({
      def: {} as never,
      value: 777,
      source: "db",
    });
    expect(await effectiveGlobalRateLimitMax(300)).toBe(777);
  });
});
