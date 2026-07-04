import { describe, it, expect } from "vitest";
import { buildPayrollRows } from "../src/services/payroll";
import { mytMonthBoundsForKey } from "../src/lib/myt";

/**
 * The clerk's month-end sheet: per-driver totals are month-bounded sums of the
 * STORED per-trip incentive_earned (never recomputed), using the same
 * [start, end) predicate as every other money figure.
 */

const JULY = mytMonthBoundsForKey("2026-07")!;

const trip = (over: Partial<{ id: string; ticket_number: string; pickup_datetime: Date; delivered_at: Date | null; incentive_earned: unknown }>) => ({
  id: "t1",
  ticket_number: "TKT-20260710-001",
  pickup_datetime: new Date("2026-07-10T01:00:00Z"),
  delivered_at: new Date("2026-07-10T05:00:00Z"),
  incentive_earned: 44,
  ...over,
});

describe("mytMonthBoundsForKey", () => {
  it("parses a YYYY-MM key into the MYT month bounds", () => {
    expect(JULY.start.toISOString()).toBe("2026-06-30T16:00:00.000Z"); // 1 Jul 00:00 MYT
    expect(JULY.end.toISOString()).toBe("2026-07-31T16:00:00.000Z"); // 1 Aug 00:00 MYT
  });

  it("rejects malformed or impossible keys", () => {
    expect(mytMonthBoundsForKey("2026-7")).toBeNull();
    expect(mytMonthBoundsForKey("2026-13")).toBeNull();
    expect(mytMonthBoundsForKey("garbage")).toBeNull();
  });
});

describe("buildPayrollRows — the month-end payroll sheet", () => {
  it("totals are the month-bounded sum of stored per-trip pay; out-of-month trips are excluded", () => {
    const rows = buildPayrollRows(
      [
        {
          id: "d1",
          name: "Azmi",
          employee_number: "H593",
          trips: [
            trip({ id: "a", incentive_earned: 44 }),
            trip({ id: "b", incentive_earned: "13.5" }), // Decimal serialises as string
            // Booked-ahead trip with an August pickup — the exact leak the
            // month-bound fix closed; must not count in July.
            trip({ id: "c", pickup_datetime: new Date("2026-08-03T01:00:00Z"), incentive_earned: 99 }),
          ],
        },
      ],
      JULY
    );
    expect(rows[0].trip_count).toBe(2);
    expect(rows[0].total).toBe(57.5);
    expect(rows[0].employee_number).toBe("H593");
    expect(rows[0].trips.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("rounds float dust to cents — this figure is what payroll pays", () => {
    const rows = buildPayrollRows(
      [
        {
          id: "d1",
          name: "Azmi",
          employee_number: null,
          trips: [
            trip({ id: "a", incentive_earned: 47.999999999999986 }),
            trip({ id: "b", incentive_earned: 96.00000000000001 }),
          ],
        },
      ],
      JULY
    );
    expect(rows[0].total).toBe(144);
    expect(rows[0].trips.map((t) => t.incentive_earned)).toEqual([48, 96]);
  });

  it("sorts drivers by month total (top earner first) and trips by pickup time", () => {
    const rows = buildPayrollRows(
      [
        { id: "d1", name: "Low", employee_number: null, trips: [trip({ incentive_earned: 10 })] },
        {
          id: "d2",
          name: "High",
          employee_number: null,
          trips: [
            trip({ id: "later", pickup_datetime: new Date("2026-07-20T01:00:00Z") }),
            trip({ id: "earlier", pickup_datetime: new Date("2026-07-05T01:00:00Z") }),
          ],
        },
      ],
      JULY
    );
    expect(rows.map((r) => r.name)).toEqual(["High", "Low"]);
    expect(rows[0].trips.map((t) => t.id)).toEqual(["earlier", "later"]);
  });
});
