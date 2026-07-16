import { describe, it, expect } from "vitest";
import authRouter from "../src/routes/auth";
import { sensitiveRateLimiter } from "../src/middleware/rateLimit";

/**
 * Tripwire: `/login` must carry the strict per-IP limiter. It was imported into
 * auth.ts and applied to password change/reset but NOT to login for a long time
 * — login looked protected and wasn't (only the loose global 100/min). This
 * asserts the middleware is on the route by reference, so dropping it fails a
 * test instead of silently re-opening credential stuffing. Env-independent:
 * checks the wiring, not the runtime limit.
 */
function routeHandles(path: string, method: string): unknown[] {
  const layer = (authRouter as unknown as { stack: any[] }).stack.find(
    (l) => l.route?.path === path && l.route?.methods?.[method]
  );
  return layer ? layer.route.stack.map((s: any) => s.handle) : [];
}

describe("auth route rate-limiting", () => {
  it("mounts sensitiveRateLimiter on POST /login", () => {
    expect(routeHandles("/login", "post")).toContain(sensitiveRateLimiter);
  });

  it("keeps it on the account-security routes it already guarded", () => {
    expect(routeHandles("/forgot-password", "post")).toContain(sensitiveRateLimiter);
  });
});
