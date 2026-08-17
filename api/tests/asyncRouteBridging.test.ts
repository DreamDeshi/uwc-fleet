import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AN UNBRIDGED ASYNC HANDLER IS A HOLE IN THE MONITORING, NOT A STYLE ISSUE.
 *
 * This is Express 4. It does not follow a returned promise, so when an `async`
 * handler rejects, the rejection never reaches `errorHandler`. The request hangs
 * until the client gives up. There is no 500, no `console.error`, and therefore
 * NO SENTRY EVENT.
 *
 * That is strictly worse than having no monitoring: the dashboard stays clean
 * while the endpoint is down, so the one signal anybody would act on is the
 * signal that goes missing. Sentry was installed on 31 Jul precisely so failures
 * stop depending on someone noticing — a route that fails silently defeats it.
 *
 * `routes/public.ts` was the only offender: at calibration (1 Aug 2026) the GUARD
 * below counted 98 async handlers registered across src/routes, 97 correct by
 * convention alone and one not. Convention held 99% of the time, which is exactly
 * the hit rate that makes a defect survive review.
 *
 * ⚠ 98 is a POINT-IN-TIME figure produced by the GUARD's own regex — `async (`,
 * over every `router.<verb>(` including `use`. A hand-count with a narrower
 * pattern gets a different and wrong-looking answer: `async (req` matches only
 * 76, because 22 handlers name or destructure their first argument differently.
 * That is how public.ts came to carry "77 handlers, 76 correct" while this file
 * said 98 and 97 — two comments, both confident, one of them counting something
 * else. If you need the number, run the guard. Do not quote it from prose.
 *
 * Three tests, because none of them is sufficient alone:
 *
 *   1. MECHANISM — a synthetic app proves Express really does hang, so tests 2
 *      and 3 are enforcing a real failure mode rather than a preference.
 *   2. REAL ROUTE — the shipped /track/:token handler with a failing database,
 *      proving the bridge works where it actually ships.
 *   3. GUARD — every async handler in src/routes, so the next one added is
 *      covered without anyone remembering this file exists.
 */

vi.mock("../src/lib/prisma", () => ({
  prisma: { trip: { findUnique: vi.fn() } },
}));

import { prisma } from "../src/lib/prisma";
import publicRoutes from "../src/routes/public";
import { errorHandler } from "../src/middleware/errorHandler";
import { signTrackingToken } from "../src/lib/trackingToken";

/**
 * How long a "did it settle?" race waits before calling the request HUNG.
 *
 * ⚠ THIS IS A DEADLINE, NOT A DELAY — and it is the only timing in this file,
 * so it is the first suspect when the suite flakes. `asyncRouteBridging` was
 * seen failing twice on 18 Aug 2026 and passing on immediate re-run; there is
 * no port to pin (supertest binds an ephemeral one per request), which leaves
 * this race as the mechanism: on a loaded runner a request that WOULD respond
 * can outlive the deadline and be reported as a hang.
 *
 * Raising it is safe in both directions and weakens nothing. The unbridged
 * case asserts HUNG, so more time only makes that proof stronger — a genuine
 * hang stays hung however long you wait. The bridged case asserts a response,
 * and more time is exactly what stops a slow-but-correct response being
 * misread. The cost is paid only when a test actually fails.
 *
 * If it recurs at 5s, the cause is NOT scheduling latency and this note has
 * ruled one thing out rather than nothing.
 */
const SETTLE_DEADLINE_MS = 5000;

/** Did the request settle, or is it still open? Never waits longer than `ms`. */
async function settlesWithin(app: express.Express, path: string, ms: number): Promise<string> {
  return Promise.race([
    request(app)
      .get(path)
      .then((r) => `responded:${r.status}`)
      .catch(() => "socket-error"),
    new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), ms)),
  ]);
}

describe("async route handlers must bridge rejections to errorHandler", () => {
  it("MECHANISM: without the bridge the request HANGS — no status, no report", async () => {
    // The rejection genuinely goes unhandled; that is the defect being shown.
    // Swallow it so the demonstration does not fail the runner.
    const swallow = () => {};
    process.on("unhandledRejection", swallow);
    try {
      const unbridged = express();
      unbridged.get("/boom", async () => {
        throw new Error("db unreachable");
      });
      unbridged.use(errorHandler);

      expect(
        await settlesWithin(unbridged, "/boom", SETTLE_DEADLINE_MS),
        "Express 4 delivered an async rejection to errorHandler — if this ever passes, " +
          "the framework changed and the rest of this file is over-caution rather than a fix"
      ).toBe("HUNG");
    } finally {
      process.off("unhandledRejection", swallow);
    }
  });

  it("MECHANISM: with the bridge the SAME failure becomes a reportable 500", async () => {
    const bridged = express();
    bridged.get("/boom", async (_req, _res, next) => {
      try {
        throw new Error("db unreachable");
      } catch (err) {
        next(err);
      }
    });
    bridged.use(errorHandler);

    expect(await settlesWithin(bridged, "/boom", SETTLE_DEADLINE_MS)).toBe("responded:500");
  });

  it("REAL ROUTE: a database failure on /track/:token is a 500, not a hang", async () => {
    vi.mocked(prisma.trip.findUnique).mockRejectedValueOnce(
      new Error("Can't reach database server at `postgresql://uwc:pw@host:6543/railway`")
    );

    const app = express();
    app.use("/track", publicRoutes);
    app.use(errorHandler);

    const res = await request(app).get(`/track/${signTrackingToken("ckprobe123")}`);
    expect(res.status).toBe(500);
    // The generic body is deliberate: the tracking page is public, so the
    // recipient must never see the connection string that caused it.
    expect(res.body?.error?.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("postgresql");
  });

  it("REAL ROUTE: the ordinary paths still behave — a bad token is a 404, not a 500", async () => {
    // Over-catching would turn every miss into a server error and bury the
    // signal, which is the failure mode opposite to the one being fixed.
    const app = express();
    app.use("/track", publicRoutes);
    app.use(errorHandler);

    const res = await request(app).get("/track/not-a-real-token");
    expect(res.status).toBe(404);
    expect(prisma.trip.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "not-a-real-token" } })
    );
  });

  it("GUARD: every async handler in src/routes bridges its rejections", () => {
    const dir = join(__dirname, "..", "src", "routes");
    const CALL = /router\.(get|post|put|patch|delete|use)\s*\(/g;
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      const starts = [...src.matchAll(CALL)].map((m) => m.index as number);

      starts.forEach((start, i) => {
        // Each registration's code runs to the next registration, so this slice
        // is exactly one route's body without needing to balance braces through
        // template literals and CSS.
        const slice = src.slice(start, starts[i + 1] ?? src.length);
        if (!/async\s*\(/.test(slice.slice(0, 400))) return;
        scanned++;
        if (/catch\s*\(/.test(slice) && /next\s*\(/.test(slice)) return;
        offenders.push(`${file}:${src.slice(0, start).split(/\r?\n/).length}`);
      });
    }

    // Non-vacuity: if the scan matches nothing (a refactor to a different
    // registration style), it would pass by finding no handlers at all.
    expect(scanned, "the scan found no async handlers — it has stopped testing anything").toBeGreaterThan(50);
    expect(offenders, `async handlers with no rejection bridge: ${offenders.join(", ")}`).toEqual([]);
  });
});
