import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, REQUESTOR, ADMIN } from "./helpers/harness";
import { sentryEnabled } from "../src/lib/sentry";

/**
 * MONITORING IS OFF UNLESS DELIBERATELY TURNED ON, AND IT NEVER CHANGES A REPLY.
 *
 * Two properties, and the second is the one that would actually hurt:
 *
 *   1. No SENTRY_DSN ⇒ nothing initialises. That is dev, CI, both test suites
 *      and production until someone sets the variable. A monitoring tool that
 *      behaves differently when absent is a liability, and CI would be sending
 *      real error reports from every run.
 *
 *   2. Adding reporting to errorHandler must not have changed one status code,
 *      error code or message. The reports go ALONGSIDE the reply — a regression
 *      here would be an outage caused by the tool meant to detect outages.
 *
 * The scrubbing rules themselves are unit-tested (tests/sentryScrub.test.ts);
 * this file is about wiring.
 */
describe("Sentry is off without a DSN, and invisible to the API", () => {
  let requestor = "", admin = "";

  beforeAll(async () => {
    [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    await resetDb();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("is NOT enabled in the test environment", () => {
    // If this ever fails, CI has a DSN configured and every run is shipping
    // error reports for deliberately-provoked failures.
    expect(process.env.SENTRY_DSN ?? "").toBe("");
    expect(sentryEnabled()).toBe(false);
  });

  it("the ordinary error responses are unchanged", async () => {
    // A representative 4xx from each shape errorHandler branches on. These are
    // the codes clients switch on; reporting must not have touched them.
    const notFound = await api().get("/api/v1/trips/does-not-exist").set(auth(requestor));
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe("TRIP_NOT_FOUND");

    const forbidden = await api().get("/api/v1/reports/consolidation").set(auth(requestor));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");

    const unauth = await api().get("/api/v1/trips");
    expect(unauth.status).toBe(401);

    const badBody = await api()
      .post("/api/v1/trips")
      .set(auth(requestor))
      .send({ route_type_id: "" });
    expect(badBody.status).toBe(400);

    // ...and a success is still a success.
    const ok = await api().get("/api/v1/reports/consolidation").set(auth(admin));
    expect(ok.status).toBe(200);
  });

  it("a 4xx is not a server error — nothing is reported for it", () => {
    // captureServerError returns null when disabled, which is what every call
    // above got. The POSITIVE case (a 500 IS reported) cannot be asserted
    // without a live DSN, so it is deliberately not faked here: a test that
    // stubs the SDK would assert that my stub was called, not that Sentry
    // receives anything. The scrubber — the part that can leak — is what has
    // real coverage.
    expect(sentryEnabled()).toBe(false);
  });
});
