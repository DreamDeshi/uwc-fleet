import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { isUniqueViolation } from "../src/lib/prismaErrors";
import { ticketDatePart, ticketSequence } from "../src/routes/trips";

/**
 * Atomic ticket generation: concurrent bookings racing the count-then-create
 * window collide on the @unique ticket_number; the create route retries with a
 * bumped sequence when it sees exactly that violation (and only that one).
 */

function p2002(target: string[] | string | undefined): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.20.0",
    meta: target === undefined ? undefined : { target },
  });
}

describe("isUniqueViolation", () => {
  it("matches a P2002 on the named column", () => {
    expect(isUniqueViolation(p2002(["ticket_number"]), "ticket_number")).toBe(true);
    expect(isUniqueViolation(p2002("Trip_ticket_number_key"), "ticket_number")).toBe(true);
  });

  it("does not match a P2002 on a different column", () => {
    expect(isUniqueViolation(p2002(["phone"]), "ticket_number")).toBe(false);
  });

  it("does not match other Prisma errors or plain errors", () => {
    const p2034 = new Prisma.PrismaClientKnownRequestError("conflict", {
      code: "P2034",
      clientVersion: "5.20.0",
    });
    expect(isUniqueViolation(p2034, "ticket_number")).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "ticket_number")).toBe(false);
  });

  it("a P2002 with no target metadata still matches (retry beats a 500)", () => {
    expect(isUniqueViolation(p2002(undefined), "ticket_number")).toBe(true);
  });
});

describe("ticketDatePart — MYT day, not the server-local day", () => {
  it("an instant late on the UTC day belongs to the NEXT MYT day", () => {
    // 2026-07-01 17:00 UTC = 2026-07-02 01:00 MYT.
    expect(ticketDatePart(new Date("2026-07-01T17:00:00Z"))).toBe("20260702");
    expect(ticketDatePart(new Date("2026-07-01T09:00:00Z"))).toBe("20260701");
  });
});

describe("ticketSequence — retry dispersion (the lockstep fix)", () => {
  it("attempt 0 is the clean sequential number — no randomness applied", () => {
    // rand would blow up if called: proves the first attempt never jitters.
    const explode = () => {
      throw new Error("rand must not be called on attempt 0");
    };
    expect(ticketSequence(5, 0, explode)).toBe(6);
    expect(ticketSequence(0, 0, explode)).toBe(1);
  });

  it("retries bump past the winner even with zero jitter (old behaviour preserved as the floor)", () => {
    expect(ticketSequence(5, 1, () => 0)).toBe(7); // count+1+attempt
    expect(ticketSequence(5, 2, () => 0)).toBe(8);
  });

  it("retries disperse: different rand draws → different sequences at the SAME count+attempt", () => {
    // This is the property that breaks lockstep — two losers re-counting the
    // same countToday at the same attempt no longer compute the same number.
    const low = ticketSequence(5, 1, () => 0.0);
    const high = ticketSequence(5, 1, () => 0.99);
    expect(low).not.toBe(high);
    expect(high).toBe(5 + 1 + 1 + 7); // floor(0.99 * 8 * 1) = 7
  });

  it("the spread widens with the attempt number", () => {
    // attempt 1 spans 8 values, attempt 3 spans 24 — later rounds scatter wider.
    expect(ticketSequence(0, 1, () => 0.99)).toBe(0 + 1 + 1 + 7);
    expect(ticketSequence(0, 3, () => 0.99)).toBe(0 + 1 + 3 + 23);
  });
});
