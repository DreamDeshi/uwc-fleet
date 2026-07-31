import { describe, it, expect } from "vitest";
import {
  REDACTED,
  REDACTED_HEADERS,
  scrubDeep,
  scrubHeaders,
  scrubQueryString,
  scrubText,
} from "../src/lib/sentryScrub";

/**
 * EVERYTHING HERE IS ABOUT DATA LEAVING THE BUILDING.
 *
 * Sentry is a third party. A failure in this file is not a wrong number on a
 * screen — it is a customer list, an employee's phone number or the production
 * database password sitting in someone else's UI, retained on their schedule.
 *
 * So the cases below are the REAL shapes, not invented ones: the actual Prisma
 * "can't reach database server" sentence, the actual consignee-search URL, the
 * actual +60 phone format lib/phone normalises to.
 */

describe("scrubText — the four things that would actually leak", () => {
  it("a Prisma error carrying the DATABASE_URL", () => {
    // The real shape. An init or pool failure stringifies the connection string,
    // credentials and all — the production database password, uploaded
    // automatically, inside an ordinary-looking exception message.
    const msg =
      "Can't reach database server at `postgresql://uwc:s3cr3tP4ss@containers-us-west-1.railway.app:6543/railway?schema=public`";
    const out = scrubText(msg);
    expect(out).not.toContain("s3cr3tP4ss");
    expect(out).not.toContain("uwc:");
    expect(out).toContain("postgresql://[redacted]");
  });

  it("every URI scheme with credentials, not just postgres", () => {
    for (const uri of [
      "mysql://root:hunter2@db:3306/x",
      "mongodb://admin:pw@cluster0/x",
      "redis://user:tok3n@cache:6379",
      "postgres://a:b@h/d",
    ]) {
      expect(scrubText(`connect ${uri} failed`), uri).not.toMatch(/hunter2|pw@|tok3n|:b@/);
    }
  });

  it("a bearer token and a raw JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbTh4eHgiLCJyb2xlIjoiZHJpdmVyIn0.abcdefghijklmnop";
    expect(scrubText(`token ${jwt} rejected`)).not.toContain(jwt);
    expect(scrubText(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
  });

  it("Malaysian phone numbers — the login identity for every driver", () => {
    for (const phone of ["+60123456789", "0123456789", "+6012-345 6789", "012-3456789"]) {
      const out = scrubText(`login failed for ${phone}`);
      expect(out, phone).toContain(REDACTED);
      expect(out, phone).not.toContain("3456789");
    }
  });

  it("email addresses", () => {
    expect(scrubText("notify teh@example.com.my about it")).not.toContain("teh@example.com.my");
  });

  it("leaves ordinary diagnostic text alone", () => {
    // Over-scrubbing makes the tool useless. Ticket numbers, cuids, zone codes,
    // plates and stack frames must survive — they are the whole diagnostic value.
    const msg =
      "TRIP_NOT_FOUND for cms8azbyq00gph2ax766fxqf5 (TKT-20260731-004, zone A2, PND 1888) at services/tripFinalize.ts:123";
    expect(scrubText(msg)).toBe(msg);
  });
});

describe("scrubHeaders", () => {
  it("redacts the credential headers by NAME, whatever the casing", () => {
    const out = scrubHeaders({
      Authorization: "Bearer abc.def.ghi",
      COOKIE: "session=xyz",
      "X-Api-Key": "k",
      "user-agent": "okhttp/4.9",
      "content-type": "application/json",
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out.COOKIE).toBe(REDACTED);
    expect(out["X-Api-Key"]).toBe(REDACTED);
    // ...and keeps the ones that help diagnose.
    expect(out["user-agent"]).toBe("okhttp/4.9");
    expect(out["content-type"]).toBe("application/json");
  });

  it("still scrubs the VALUE of a header not on the name list", () => {
    // A proxy or client can put anything in a custom header.
    const out = scrubHeaders({ "x-forwarded-user": "+60123456789" });
    expect(out["x-forwarded-user"]).toBe(REDACTED);
  });

  it("the redacted-name list covers the credential headers this API sees", () => {
    for (const h of ["authorization", "cookie", "set-cookie", "x-api-key"]) {
      expect(REDACTED_HEADERS.has(h), h).toBe(true);
    }
  });
});

describe("scrubQueryString — the query IS customer data here", () => {
  it("redacts a consignee search term", () => {
    // /consignees?search=… is a real customer name. This is the case that makes
    // query scrubbing non-optional rather than tidy.
    expect(scrubQueryString("/api/v1/consignees?search=KEYSIGHT&zone=P1")).toBe(
      "/api/v1/consignees?search=[redacted]&zone=[redacted]"
    );
  });

  it("keeps the path and the keys — they are the diagnostic content", () => {
    const out = scrubQueryString("/api/v1/trips?q=ACME&status=pending&page_size=20");
    expect(out.startsWith("/api/v1/trips?")).toBe(true);
    for (const key of ["q", "status", "page_size"]) expect(out).toContain(`${key}=`);
    expect(out).not.toContain("ACME");
  });

  it("leaves a query-less URL untouched", () => {
    expect(scrubQueryString("/api/v1/trips/cms8azbyq00gph2ax766fxqf5")).toBe(
      "/api/v1/trips/cms8azbyq00gph2ax766fxqf5"
    );
  });

  it("handles a valueless flag and a trailing ?", () => {
    expect(scrubQueryString("/x?flag")).toBe("/x?flag");
    expect(scrubQueryString("/x?")).toBe("/x");
  });
});

describe("scrubDeep", () => {
  it("reaches strings at any depth", () => {
    const out = scrubDeep({
      a: { b: [{ msg: "call +60123456789" }] },
    }) as { a: { b: { msg: string }[] } };
    expect(out.a.b[0].msg).toContain(REDACTED);
  });

  it("redacts a credential KEY wherever it appears in a structure", () => {
    const out = scrubDeep({ headers: { authorization: "Bearer x" } }) as {
      headers: { authorization: string };
    };
    expect(out.headers.authorization).toBe(REDACTED);
  });

  it("is bounded, so a cyclic-ish or vast payload cannot spin", () => {
    let deep: Record<string, unknown> = { v: "+60123456789" };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    expect(() => scrubDeep(deep)).not.toThrow();

    const big = scrubDeep(Array.from({ length: 5000 }, () => "x")) as unknown[];
    expect(big.length).toBeLessThanOrEqual(100);
  });

  it("passes non-plain objects through rather than flattening them", () => {
    // Rebuilding a Date/Buffer would destroy the prototype the serializer needs
    // — the same trap redactRequestorMoney documents.
    const d = new Date("2026-07-31T00:00:00Z");
    expect(scrubDeep(d)).toBe(d);
  });

  // ── ...WITH ERRORS AS THE DELIBERATE EXCEPTION TO THE RULE ABOVE ───────────
  // Found on production 31 Jul: errorHandler logs `console.error(err)`, Sentry's
  // console integration puts the RAW Error in breadcrumb data.arguments, and the
  // pass-through above shipped it unscrubbed. Every reported 500 carried an
  // unscrubbed duplicate of its own message — the DB password, for a Prisma
  // connection failure. An Error is not opaque data; it is a message with a
  // prototype, so it gets flattened and scrubbed.
  it("flattens and scrubs an ERROR, which the rule above would have passed through", () => {
    const err = new Error(
      "Can't reach database server at `postgresql://uwc:s3cr3tP4ss@host:6543/railway`, driver +60123456789"
    );
    const out = scrubDeep(err) as { name: string; message: string; stack?: string };

    expect(out).not.toBeInstanceOf(Error);
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain("s3cr3tP4ss");
    expect(out.message).not.toContain("60123456789");
    expect(out.message).toContain(REDACTED);
    // The stack names real files and is the diagnostic payload — kept, scrubbed.
    expect(out.stack).toBeTypeOf("string");
    expect(out.stack).not.toContain("s3cr3tP4ss");
  });

  it("scrubs an error's OWN properties too — Prisma hangs query detail off `meta`", () => {
    const err = Object.assign(new Error("query failed"), {
      code: "P2002",
      meta: { target: "+60123456789", url: "postgresql://uwc:s3cr3tP4ss@host:6543/db" },
    });
    const out = scrubDeep(err) as { code: string; meta: { target: string; url: string } };

    expect(out.code, "the diagnostic code must survive").toBe("P2002");
    expect(out.meta.target).toBe(REDACTED);
    expect(out.meta.url).not.toContain("s3cr3tP4ss");
  });

  it("finds an error NESTED inside an ordinary structure", () => {
    // The real shape: breadcrumb data is { arguments: [Error] }, not a bare Error.
    const out = scrubDeep({
      arguments: [new Error("db=postgresql://uwc:s3cr3tP4ss@host:6543/db")],
    }) as { arguments: { message: string }[] };
    expect(out.arguments[0].message).not.toContain("s3cr3tP4ss");
    expect(out.arguments[0].message).toContain(REDACTED);
  });
});
