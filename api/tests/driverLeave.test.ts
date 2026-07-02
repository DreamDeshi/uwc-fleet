import { describe, it, expect } from "vitest";
import { leaveCoversDate, leaveDateFilter } from "../src/services/driverLeave";
import { mytDateKey } from "../src/services/incentiveEngine";
import { selectTruck, type TruckCandidate } from "../src/services/dispatchEngine";

/**
 * Driver leave (tracker #4) — date-based dispatch availability. The rule is a
 * plain inclusive range check over MYT "YYYY-MM-DD" keys; the Prisma filter
 * used by the auto candidate query is built from the same helper, and these
 * tests pin both to the same semantics.
 */

describe("leaveCoversDate — inclusive MYT date-range check", () => {
  const leave = { start_date: "2026-03-20", end_date: "2026-03-22" };

  it("covers the start and end dates inclusively, and days between", () => {
    expect(leaveCoversDate(leave, "2026-03-20")).toBe(true);
    expect(leaveCoversDate(leave, "2026-03-21")).toBe(true);
    expect(leaveCoversDate(leave, "2026-03-22")).toBe(true);
  });

  it("does not cover the days just outside the range (available 03-19 and 03-23)", () => {
    expect(leaveCoversDate(leave, "2026-03-19")).toBe(false);
    expect(leaveCoversDate(leave, "2026-03-23")).toBe(false);
  });

  it("a single-day leave (end = start) covers exactly that day", () => {
    const oneDay = { start_date: "2026-03-20", end_date: "2026-03-20" };
    expect(leaveCoversDate(oneDay, "2026-03-20")).toBe(true);
    expect(leaveCoversDate(oneDay, "2026-03-19")).toBe(false);
    expect(leaveCoversDate(oneDay, "2026-03-21")).toBe(false);
  });
});

describe("leaveDateFilter — the Prisma where-fragment mirrors leaveCoversDate", () => {
  it("matches exactly the rows leaveCoversDate covers", () => {
    const rows = [
      { start_date: "2026-03-20", end_date: "2026-03-22" },
      { start_date: "2026-03-23", end_date: "2026-03-23" },
      { start_date: "2026-01-01", end_date: "2026-12-31" },
    ];
    const key = "2026-03-22";
    const f = leaveDateFilter(key);
    // Simulate the SQL: start_date <= key AND end_date >= key.
    const sqlMatched = rows.filter(
      (r) => r.start_date <= f.start_date.lte && r.end_date >= f.end_date.gte
    );
    const pureMatched = rows.filter((r) => leaveCoversDate(r, key));
    expect(sqlMatched).toEqual(pureMatched);
    expect(pureMatched).toHaveLength(2);
  });
});

describe("leave is keyed to the pickup's MYT day (UTC+8), not the UTC day", () => {
  it("a pickup at 17:00 UTC belongs to the NEXT MYT day for leave purposes", () => {
    // 2026-03-19 17:00 UTC = 2026-03-20 01:00 MYT → covered by leave on 03-20.
    const leave = { start_date: "2026-03-20", end_date: "2026-03-20" };
    expect(leaveCoversDate(leave, mytDateKey(new Date("2026-03-19T17:00:00Z")))).toBe(true);
    // 2026-03-19 09:00 UTC = 2026-03-19 17:00 MYT → still the 19th, not covered.
    expect(leaveCoversDate(leave, mytDateKey(new Date("2026-03-19T09:00:00Z")))).toBe(false);
  });
});

describe("dispatch behaviour when the only eligible driver is on leave", () => {
  // Candidates reach selectTruck AFTER the DB filter has removed on-leave
  // drivers (dispatchEngine's `leaves: { none: leaveDateFilter(...) }`).
  // Model that filter here and show the A2 order then has no candidate — the
  // engine returns null, which the caller turns into pending + the
  // auto_dispatch_failed "needs attention" flag (existing behaviour).
  const plx: TruckCandidate = {
    plate: "PLX 2406",
    driverId: "driver-1",
    maxPallets: 16,
    currentLoad: 0,
    coverageZones: ["A1", "A2", "P1", "P2"],
    activeZones: [],
  };
  const leaves = new Map([["driver-1", [{ start_date: "2026-03-20", end_date: "2026-03-20" }]]]);

  function candidatesFor(pickupKey: string): TruckCandidate[] {
    return [plx].filter(
      (c) => !(leaves.get(c.driverId) ?? []).some((l) => leaveCoversDate(l, pickupKey))
    );
  }

  it("on the leave date the pool is empty → no assignment (trip stays pending)", () => {
    const sel = selectTruck({ pallets: 2, zone: "A2" }, candidatesFor("2026-03-20"), {});
    expect(sel).toBeNull();
  });

  it("the SAME driver is assignable for a pickup on another date", () => {
    const sel = selectTruck({ pallets: 2, zone: "A2" }, candidatesFor("2026-03-19"), {});
    expect(sel?.plate).toBe("PLX 2406");
  });
});
