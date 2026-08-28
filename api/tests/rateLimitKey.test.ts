import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import supertest from "supertest";
import { createGlobalRateLimiter, rateLimitKey } from "../src/middleware/rateLimit";
import { signAccessToken } from "../src/lib/jwt";

/**
 * THE BUG THIS FILE EXISTS FOR (found by the 3 Aug 2026 end-to-end run):
 *
 * The global limiter counted 100 requests/minute against the CLIENT IP. Every
 * UWC requestor and admin shares one office egress IP, and `trust proxy` is on,
 * so they all landed in ONE bucket. The admin board alone polls ~20 req/min per
 * open session with nobody touching it, so five idle sessions exhausted the
 * budget — and the request that got refused in the real run was a driver's
 * `delivered`, the call that records his pay.
 *
 * The fix keys an AUTHENTICATED request on the user id, so one busy screen can
 * never throttle another person. Anonymous traffic stays IP-keyed; login keeps
 * its own stricter per-IP limiter (sensitiveRateLimiter), so credential
 * stuffing is unaffected.
 *
 * ⚠ THE KEY MUST BE DERIVED FROM A *VERIFIED* TOKEN. Reading `sub` out of an
 * unverified JWT would let anyone mint an unlimited supply of fresh buckets by
 * inventing user ids — a worse hole than the one being closed. A token that
 * fails verification therefore falls back to the IP bucket, exactly as if it
 * had not been sent.
 */

// The limiter reads only headers and req.ip, so a bare app is enough — no DB.
function appWithLimiter(limit: number) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createGlobalRateLimiter(limit));
  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/v1/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let tokenA = "";
let tokenB = "";

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET ||= "rate-limit-key-test-secret";
  tokenA = signAccessToken({ sub: "user-aaa", role: "driver" });
  tokenB = signAccessToken({ sub: "user-bbb", role: "admin" });
});

describe("rateLimitKey", () => {
  it("keys a verified token on its user id, not the IP", () => {
    const req = { ip: "203.0.113.7", headers: { authorization: `Bearer ${tokenA}` } } as never;
    expect(rateLimitKey(req)).toBe("user:user-aaa");
  });

  it("keys two different users differently from the SAME ip", () => {
    const ip = "203.0.113.7";
    const a = rateLimitKey({ ip, headers: { authorization: `Bearer ${tokenA}` } } as never);
    const b = rateLimitKey({ ip, headers: { authorization: `Bearer ${tokenB}` } } as never);
    expect(a).not.toBe(b);
  });

  it("falls back to the IP when there is no token", () => {
    expect(rateLimitKey({ ip: "203.0.113.7", headers: {} } as never)).toBe("ip:203.0.113.7");
  });

  it("falls back to the IP for a FORGED token — a fake sub cannot mint a bucket", () => {
    // Signed with the wrong secret: verification must fail and the request must
    // be counted against the IP, not against the id the attacker chose.
    const forged = require("jsonwebtoken").sign({ sub: "attacker-picked", role: "admin" }, "not-the-real-secret");
    expect(rateLimitKey({ ip: "203.0.113.9", headers: { authorization: `Bearer ${forged}` } } as never)).toBe(
      "ip:203.0.113.9"
    );
  });

  it("falls back to the IP for a malformed Authorization header", () => {
    const req = { ip: "203.0.113.9", headers: { authorization: "Bearer not-a-jwt" } } as never;
    expect(rateLimitKey(req)).toBe("ip:203.0.113.9");
  });
});

describe("global limiter — one office IP, many people", () => {
  it("does NOT throttle user B because user A used the budget (THE BUG)", async () => {
    const api = supertest(appWithLimiter(3));
    // Both users arrive from the SAME office IP.
    const ip = "198.51.100.20";
    for (let i = 0; i < 3; i++) {
      const r = await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
      expect(r.status).toBe(200);
    }
    // A is now out of budget…
    const aBlocked = await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    expect(aBlocked.status).toBe(429);

    // …but B, a different person on the same IP, must still be served. This is
    // the driver whose `delivered` was refused because the office was busy.
    const bOk = await api.get("/api/v1/ping").set(bearer(tokenB)).set("X-Forwarded-For", ip);
    expect(bOk.status).toBe(200);
  });

  it("still throttles a single user who exceeds their own budget", async () => {
    const api = supertest(appWithLimiter(2));
    const ip = "198.51.100.21";
    await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    const blocked = await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429);
  });

  it("still throttles anonymous traffic per IP", async () => {
    const api = supertest(appWithLimiter(2));
    const ip = "198.51.100.22";
    await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    const blocked = await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429);
  });

  it("answers 429 in the app's error envelope, so the client can read it", async () => {
    const api = supertest(appWithLimiter(1));
    const ip = "198.51.100.23";
    await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    const blocked = await api.get("/api/v1/ping").set(bearer(tokenA)).set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429);
    // mobile/src/services/api.ts reads data.error.message and data.error.code —
    // the library's default plain-text body parses as neither, so a throttled
    // driver saw a generic failure instead of "wait a minute".
    expect(blocked.body?.error?.code).toBe("RATE_LIMITED");
    expect(typeof blocked.body?.error?.message).toBe("string");
  });

  it("never counts the health probe against anyone's budget", async () => {
    const api = supertest(appWithLimiter(1));
    const ip = "198.51.100.24";
    for (let i = 0; i < 5; i++) {
      const r = await api.get("/api/v1/health").set("X-Forwarded-For", ip);
      expect(r.status).toBe(200);
    }
    // The budget is untouched, so a real request still gets through.
    const real = await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    expect(real.status).toBe(200);
  });

  it("limit 0 disables it entirely (the local e2e path)", async () => {
    const api = supertest(appWithLimiter(0));
    for (let i = 0; i < 10; i++) {
      const r = await api.get("/api/v1/ping").set("X-Forwarded-For", "198.51.100.25");
      expect(r.status).toBe(200);
    }
  });
});

/**
 * Admin-settings Phase 6 (28 Aug 2026) — the MECHANISM the live settings path
 * depends on: createGlobalRateLimiter also accepts a FUNCTION, which
 * express-rate-limit must call fresh on every request rather than once at
 * construction. Proven here rather than through a real settings PATCH — see
 * tests/rateLimitSettings.test.ts's header for why a live full-app test isn't
 * possible in this suite.
 */
function appWithDynamicLimiter(limit: () => number | Promise<number>) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createGlobalRateLimiter(limit));
  app.get("/api/v1/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("global limiter — a function-valued limit (Phase 6)", () => {
  it("is RE-INVOKED per request, not frozen at construction", async () => {
    let current = 2;
    const api = supertest(appWithDynamicLimiter(() => current));
    const ip = "198.51.100.30";

    await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    const blocked = await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    expect(blocked.status).toBe(429); // the limit of 2 is reached

    // Raising the value takes effect on the VERY NEXT request. If the
    // factory had baked in whatever the function returned on its first call
    // (the bug this guards against), this would still be 429.
    current = 10;
    const allowed = await api.get("/api/v1/ping").set("X-Forwarded-For", ip);
    expect(allowed.status).toBe(200);
  });

  it("supports an ASYNC limit function — what the live settings resolver actually returns", async () => {
    const api = supertest(appWithDynamicLimiter(async () => 1));
    const ip = "198.51.100.31";

    expect((await api.get("/api/v1/ping").set("X-Forwarded-For", ip)).status).toBe(200);
    expect((await api.get("/api/v1/ping").set("X-Forwarded-For", ip)).status).toBe(429);
  });
});
