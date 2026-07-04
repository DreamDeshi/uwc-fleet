import { describe, it, expect } from "vitest";
import {
  currentMytMonthBounds,
  inMytMonth,
  mytDayIndex,
  mytMonthKey,
  mytMonthParts,
  mytMonthStart,
} from "../src/lib/myt";

/**
 * Explicit-MYT calendar helpers for aggregation/reporting. The decisive cases
 * are the instants where the MYT calendar day/month differs from the UTC one
 * (UTC 16:00–24:00 = the NEXT MYT day) — a server-local implementation gets
 * these wrong unless TZ happens to be Asia/Kuala_Lumpur.
 */

describe("mytMonthParts / mytMonthKey — month binning at the MYT boundary", () => {
  it("an instant late on the last UTC day of June is already July in MYT", () => {
    const d = new Date("2026-06-30T17:00:00Z"); // 2026-07-01 01:00 MYT
    expect(mytMonthParts(d)).toEqual({ year: 2026, month: 6 }); // July (0-based)
    expect(mytMonthKey(d)).toBe("2026-07");
  });

  it("an instant early on the first UTC day of July is still July in MYT too", () => {
    expect(mytMonthKey(new Date("2026-07-01T01:00:00Z"))).toBe("2026-07");
  });
});

describe("currentMytMonthBounds", () => {
  it("bounds are the MYT month start/end as UTC instants", () => {
    const { start, end } = currentMytMonthBounds(new Date("2026-07-15T04:00:00Z"));
    expect(start.toISOString()).toBe("2026-06-30T16:00:00.000Z"); // 2026-07-01 00:00 MYT
    expect(end.toISOString()).toBe("2026-07-31T16:00:00.000Z"); // 2026-08-01 00:00 MYT
  });

  it("a trip picked up 2026-06-30 23:00 MYT falls OUTSIDE July's bounds", () => {
    const { start } = currentMytMonthBounds(new Date("2026-07-15T04:00:00Z"));
    const juneLateNight = new Date("2026-06-30T15:00:00Z"); // 23:00 MYT June 30
    expect(juneLateNight.getTime() < start.getTime()).toBe(true);
  });
});

describe("inMytMonth — the ONE shared 'this month' predicate (finding 1.3)", () => {
  // July 2026, seen mid-month.
  const bounds = currentMytMonthBounds(new Date("2026-07-15T04:00:00Z"));

  it("a trip dated NEXT month is excluded (was leaking into unbounded >= filters)", () => {
    // Booked-ahead trip with an August pickup, completed early: before the
    // fix, /reports/drivers and /incentives/mine counted it in July while the
    // performance page didn't — two different totals for the same driver.
    expect(inMytMonth(new Date("2026-08-03T02:00:00Z"), bounds)).toBe(false);
  });

  it("start is inclusive, end is exclusive ([start, end))", () => {
    expect(inMytMonth(bounds.start, bounds)).toBe(true);
    expect(inMytMonth(bounds.end, bounds)).toBe(false);
    expect(inMytMonth(new Date(bounds.end.getTime() - 1), bounds)).toBe(true);
  });

  it("binning follows the MYT calendar, not UTC", () => {
    // 2026-06-30 17:00Z = 2026-07-01 01:00 MYT → July.
    expect(inMytMonth(new Date("2026-06-30T17:00:00Z"), bounds)).toBe(true);
    // 2026-07-31 17:00Z = 2026-08-01 01:00 MYT → August.
    expect(inMytMonth(new Date("2026-07-31T17:00:00Z"), bounds)).toBe(false);
  });
});

describe("mytMonthStart — normalises out-of-range month indices", () => {
  it("month - 5 crosses the year boundary correctly", () => {
    // 5 months before Feb 2026 = Sep 2025.
    expect(mytMonthStart(2026, 1 - 5).toISOString()).toBe("2025-08-31T16:00:00.000Z");
  });
});

describe("mytDayIndex — same-MYT-day comparisons (the on-time rule)", () => {
  it("16:30 UTC and 15:30 UTC on the same UTC day are DIFFERENT MYT days", () => {
    const before = new Date("2026-06-22T15:30:00Z"); // 23:30 MYT Jun 22
    const after = new Date("2026-06-22T16:30:00Z"); // 00:30 MYT Jun 23
    expect(mytDayIndex(after)).toBe(mytDayIndex(before) + 1);
  });

  it("00:30 and 23:30 MYT of one day share an index", () => {
    expect(mytDayIndex(new Date("2026-06-21T16:30:00Z"))).toBe(
      mytDayIndex(new Date("2026-06-22T15:30:00Z"))
    );
  });
});
