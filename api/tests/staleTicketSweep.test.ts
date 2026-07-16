import { describe, it, expect } from "vitest";
import {
  STALE_CANCELLABLE_STATUSES,
  staleTicketWhere,
  msUntilNext3amMyt,
} from "../src/services/staleTicketSweep";
import { mytDayStart } from "../src/lib/myt";

/**
 * The 3am stale-ticket auto-cancel (feedback item 8). These pin the two things
 * money/capacity safety depends on: EXACTLY which trips are cancellable (never
 * in_progress or delivered) and the "prior days only" cutoff.
 */

describe("staleTicketWhere — the cancellable scope is pinned", () => {
  const dayStart = new Date("2026-07-15T16:00:00Z"); // 2026-07-16 00:00 MYT

  it("cancels only not-yet-started statuses — never in_progress or delivered", () => {
    expect(STALE_CANCELLABLE_STATUSES).toEqual(["pending", "approved", "assigned"]);
    const w = staleTicketWhere(dayStart);
    expect(w.status).toEqual({ in: ["pending", "approved", "assigned"] });
    // Guard against a future edit silently sweeping active/finished work.
    expect(w.status.in).not.toContain("in_progress");
    expect(w.status.in).not.toContain("pending_approval");
    expect(w.status.in).not.toContain("completed");
  });

  it("only tickets whose pickup was BEFORE today 00:00 MYT (prior days)", () => {
    expect(staleTicketWhere(dayStart).pickup_datetime).toEqual({ lt: dayStart });
  });
});

describe("mytDayStart — start of today in Malaysia time", () => {
  it("returns 00:00 MYT for the calendar day containing the instant", () => {
    // 2026-07-16 18:00 MYT → day start is 2026-07-16 00:00 MYT = 2026-07-15 16:00 UTC.
    expect(mytDayStart(new Date("2026-07-16T10:00:00Z")).toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });

  it("an instant just after MYT midnight still maps to that MYT day", () => {
    // 2026-07-16 00:30 MYT = 2026-07-15 16:30 UTC → day start 2026-07-16 00:00 MYT.
    expect(mytDayStart(new Date("2026-07-15T16:30:00Z")).toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });
});

describe("msUntilNext3amMyt — the daily schedule", () => {
  const H = 60 * 60 * 1000;

  it("after 3am (08:00 MYT) → waits until tomorrow 03:00 MYT (~19h)", () => {
    // 2026-07-16 00:00 UTC = 08:00 MYT; next 3am is the 17th 03:00 MYT.
    expect(msUntilNext3amMyt(new Date("2026-07-16T00:00:00Z"))).toBe(19 * H);
  });

  it("before 3am (02:00 MYT) → waits until today 03:00 MYT (~1h)", () => {
    // 2026-07-16 18:00 UTC = 2026-07-17 02:00 MYT; next 3am is later the same MYT day.
    expect(msUntilNext3amMyt(new Date("2026-07-16T18:00:00Z"))).toBe(1 * H);
  });

  it("exactly at 3am rolls to the next day (strictly future, never 0)", () => {
    // 2026-07-15 19:00 UTC = 2026-07-16 03:00 MYT exactly → next is +24h.
    expect(msUntilNext3amMyt(new Date("2026-07-15T19:00:00Z"))).toBe(24 * H);
  });
});
