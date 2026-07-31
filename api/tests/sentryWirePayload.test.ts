import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

/**
 * WHAT ACTUALLY GOES ON THE WIRE — not what the scrub functions do in isolation.
 *
 * tests/sentryScrub.test.ts covers the pure functions. It passed completely
 * while the real payload was leaking, which is the entire reason this file
 * exists: those tests check the inputs I remembered to hand the scrubber, and
 * the SDK attaches things nobody handed it.
 *
 * ── WHAT THE FIRST WIRE AUDIT FOUND ────────────────────────────────────────
 *
 * Three layers were designed and all three worked — `exception.value`,
 * `contexts.request.url`, and the headers all came back `[redacted]`. A fourth
 * existed and nothing touched it:
 *
 *   Sentry's contextLines integration OPENS THE SOURCE FILE around every stack
 *   frame and attaches the real lines as pre_context / post_context. So a
 *   string literal sitting near a throwing line is uploaded verbatim.
 *
 * The audit shipped a database password and a customer name out of the probe's
 * own source, past a message-scrubber that was working perfectly.
 *
 * So this test drives the REAL SDK — real init, real beforeSend, real
 * serialization — with the DSN pointed at a local listener, and asserts on the
 * bytes. It is the only test here that could have caught that.
 */

const PORT = 9917;
const received: string[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(PORT, r));

  process.env.SENTRY_DSN = `http://abc123def456@localhost:${PORT}/1`;
  process.env.SENTRY_ENVIRONMENT = "wire-test";

  const { initSentry, captureServerError, flushSentry } = await import("../src/lib/sentry");
  initSentry();

  // A realistic 500 carrying every category the scrubber must remove. The
  // connection string and the customer-name URL are LITERALS IN THIS FILE on
  // purpose — that is how they reach pre_context/post_context, which is the
  // path the first audit found unguarded.
  const err = new Error(
    "Can't reach database server at `postgresql://uwc:s3cr3tP4ss@host.railway.app:6543/railway?schema=public`"
  );
  // ── THE PRODUCTION SEQUENCE, NOT JUST THE REPORTING CALL ──────────────────
  // middleware/errorHandler.ts does `console.error(err)` and THEN reports. That
  // console call becomes a breadcrumb holding the RAW Error instance, and the
  // breadcrumb rides along on the event captured immediately after.
  //
  // Testing captureServerError on its own misses it completely — which is
  // exactly what happened: this file was green while every reported 500 shipped
  // a second, unscrubbed copy of its own message in the breadcrumbs. scrubDeep
  // skipped it because an Error's prototype is not Object.prototype.
  console.error(
    new Error(
      "breadcrumb copy: postgresql://uwc:BR34DCRUMBP4SS@host.railway.app:6543/railway — driver +60127778888"
    )
  );

  captureServerError(err, {
    method: "GET",
    originalUrl: "/api/v1/consignees?search=KEYSIGHT&zone=P1",
    headers: {
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbTh4In0.SIGNATUREHERE1234",
      cookie: "session=abc123",
      "user-agent": "okhttp/4.9.2",
      // Railway forwards the real client address and the app trusts one proxy
      // hop, so on production these are a DRIVER'S IP, on the same event as
      // their user id. `sendDefaultPii: false` does not touch them.
      "x-forwarded-for": "203.0.113.77, 10.0.0.5",
      "x-real-ip": "203.0.113.77",
      "cf-connecting-ip": "203.0.113.77",
      "x-forwarded-host": "uwc-api-production.up.railway.app",
    },
    user: { id: "cms8azbyq00gph2ax766fxqf5", role: "driver" },
  });
  await flushSentry(4000);
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;
  await new Promise<void>((r) => server.close(() => r()));
});

const wire = () => received.join("\n");

describe("the Sentry envelope leaves nothing behind", () => {
  it("reaches the transport at all (otherwise everything below is vacuous)", () => {
    expect(received.length, "the SDK sent nothing — this suite would pass trivially").toBeGreaterThan(0);
    expect(wire().length).toBeGreaterThan(500);
  });

  it.each([
    ["database password", "s3cr3tP4ss"],
    ["user:pass pair", "uwc:s3cr3tP4ss"],
    ["JWT body", "eyJzdWIiOiJjbTh4In0"],
    ["JWT signature", "SIGNATUREHERE1234"],
    ["session cookie", "session=abc123"],
    ["Malaysian phone", "60123456789"],
    ["customer name in a query", "KEYSIGHT"],
    ["password from a console.error BREADCRUMB", "BR34DCRUMBP4SS"],
    ["phone from a console.error BREADCRUMB", "60127778888"],
    ["client IP", "203.0.113.77"],
    ["proxy hop IP", "10.0.0.5"],
  ])("never sends the %s", (_label, needle) => {
    expect(wire()).not.toContain(needle);
  });

  it("carries no ip_address and no CGI env, the two fields an IP hides in", () => {
    const events = wire()
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as {
            user?: { ip_address?: unknown };
            request?: { env?: unknown };
          };
        } catch {
          return null;
        }
      })
      .filter((o): o is { user?: { ip_address?: unknown }; request?: { env?: unknown } } => o !== null);

    for (const e of events) {
      expect(e.user?.ip_address, "user.ip_address is set").toBeUndefined();
      expect(e.request?.env, "request.env can carry REMOTE_ADDR").toBeUndefined();
    }
  });

  it("actually recorded a console breadcrumb — else the two above are vacuous", () => {
    // If the console integration is ever removed or reordered, the breadcrumb
    // assertions would pass by absence rather than by scrubbing. Say so loudly.
    const events = wire()
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as { breadcrumbs?: { category?: string }[] };
        } catch {
          return null;
        }
      })
      .filter((o): o is { breadcrumbs?: { category?: string }[] } => o !== null);

    const consoleCrumbs = events
      .flatMap((e) => e.breadcrumbs ?? [])
      .filter((b) => b.category === "console");
    expect(
      consoleCrumbs.length,
      "no console breadcrumb was attached — the breadcrumb leak assertions are now vacuous"
    ).toBeGreaterThan(0);
  });

  it.each([
    ["environment", "wire-test"],
    ["the endpoint path", "/api/v1/consignees"],
    ["the query KEYS", "search="],
    ["the opaque user id", "cms8azbyq00gph2ax766fxqf5"],
    ["the role", "driver"],
    ["a useful header", "okhttp"],
    ["our own hostname, which names the deployment", "uwc-api-production"],
  ])("still sends the %s — over-scrubbing makes it useless", (_label, needle) => {
    expect(wire()).toContain(needle);
  });

  it("scrubs the STACK FRAMES, not only the message", () => {
    // The specific gap the first audit found. Source context is attached by the
    // contextLines integration and is not something the caller hands over.
    const events = wire()
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => o !== null);

    const withException = events.find((e) => "exception" in e);
    expect(withException, "no exception event in the envelope").toBeTruthy();

    const frames =
      (withException as { exception?: { values?: { stacktrace?: { frames?: unknown[] } }[] } })
        .exception?.values?.[0]?.stacktrace?.frames ?? [];
    const withSource = frames.filter(
      (f) => (f as { pre_context?: unknown[]; post_context?: unknown[] }).pre_context ||
             (f as { post_context?: unknown[] }).post_context
    );
    // If Sentry ever stops attaching source context this becomes vacuous, so
    // say so rather than pass quietly.
    expect(
      withSource.length,
      "no frame carried source context — contextLines may be off, and this assertion is now vacuous"
    ).toBeGreaterThan(0);

    const sourceText = JSON.stringify(withSource);
    expect(sourceText).not.toContain("s3cr3tP4ss");
    expect(sourceText).not.toContain("KEYSIGHT");
  });
});
