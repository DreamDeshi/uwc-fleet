import { describe, it, expect } from "vitest";
import { buildPayrollRows } from "../src/services/payroll";
import { mytMonthBoundsForKey } from "../src/lib/myt";

/**
 * The clerk's month-end sheet: per-driver totals are month-bounded sums of the
 * STORED per-trip incentive_earned (never recomputed), using the same
 * [start, end) predicate as every other money figure.
 *
 * Month bucketing keys on the DELIVERY instant (delivered_at, pickup fallback
 * for the legacy null case) — the day the incentive ledger paid the trip on —
 * so this sheet and pay can never disagree about a month-crossing trip.
 */

const JULY = mytMonthBoundsForKey("2026-07")!;

const trip = (over: Partial<{ id: string; ticket_number: string; pickup_datetime: Date; delivered_at: Date | null; incentive_earned: unknown; incentive_final: unknown }>) => ({
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
            // Booked-ahead trip delivered in August — the exact leak the
            // month-bound fix closed; must not count in July.
            trip({
              id: "c",
              pickup_datetime: new Date("2026-08-03T01:00:00Z"),
              delivered_at: new Date("2026-08-03T05:00:00Z"),
              incentive_earned: 99,
            }),
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

  // POD-approval gate (16 Jul 2026): the payable is the admin-approved
  // incentive_final, which may be edited DOWN from the engine's frozen proposal
  // (incentive_earned). Payroll must pay the FINAL — not the proposal — while
  // pre-gate trips with a null final still pay their proposal (grandfathered).
  it("pays the admin-edited incentive_final, not the frozen proposal", () => {
    const rows = buildPayrollRows(
      [
        {
          id: "d1",
          name: "Azmi",
          employee_number: null,
          trips: [
            // Approved, but the admin edited the payable down (e.g. a disputed
            // drop): proposal 44, final 30 → payroll pays 30.
            trip({ id: "edited", incentive_earned: 44, incentive_final: 30 }),
            // Approved with no edit: proposal 12, final 12 → pays 12.
            trip({
              id: "approved-unchanged",
              pickup_datetime: new Date("2026-07-11T01:00:00Z"),
              delivered_at: new Date("2026-07-11T05:00:00Z"),
              incentive_earned: 12,
              incentive_final: 12,
            }),
            // Grandfathered pre-gate trip: final is null → pays the proposal 50.
            trip({
              id: "grandfathered",
              pickup_datetime: new Date("2026-07-12T01:00:00Z"),
              delivered_at: new Date("2026-07-12T05:00:00Z"),
              incentive_earned: 50,
              incentive_final: null,
            }),
          ],
        },
      ],
      JULY
    );
    const paid = Object.fromEntries(rows[0].trips.map((t) => [t.id, t.incentive_earned]));
    expect(paid.edited).toBe(30); // the FINAL, NOT the 44 proposal
    expect(paid["approved-unchanged"]).toBe(12);
    expect(paid.grandfathered).toBe(50); // proposal, since no final
    // 30 + 12 + 50 = 92 — must NOT be 106 (the sum of the frozen proposals).
    expect(rows[0].total).toBe(92);
  });

  it("buckets a month-crossing trip by its DELIVERY day — the day pay was written", () => {
    const rows = buildPayrollRows(
      [
        {
          id: "d1",
          name: "Azmi",
          employee_number: null,
          trips: [
            // Picked up 30 June, delivered 1 July → July pay (the client-question trip).
            trip({
              id: "june-pickup",
              pickup_datetime: new Date("2026-06-30T01:00:00Z"),
              delivered_at: new Date("2026-06-30T18:00:00Z"), // 1 Jul 02:00 MYT
              incentive_earned: 44,
            }),
            // Picked up 31 July, delivered 1 August → August pay, not July.
            trip({
              id: "july-pickup",
              pickup_datetime: new Date("2026-07-31T01:00:00Z"),
              delivered_at: new Date("2026-07-31T18:00:00Z"), // 1 Aug 02:00 MYT
              incentive_earned: 99,
            }),
          ],
        },
      ],
      JULY
    );
    expect(rows[0].trips.map((t) => t.id)).toEqual(["june-pickup"]);
    expect(rows[0].total).toBe(44);
  });

  it("falls back to pickup for a legacy trip with no delivered_at", () => {
    const rows = buildPayrollRows(
      [
        {
          id: "d1",
          name: "Azmi",
          employee_number: null,
          trips: [trip({ id: "legacy", delivered_at: null, incentive_earned: 20 })],
        },
      ],
      JULY
    );
    expect(rows[0].trips.map((t) => t.id)).toEqual(["legacy"]);
    expect(rows[0].total).toBe(20);
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

  it("sorts drivers by month total (top earner first) and trips by delivery time", () => {
    const rows = buildPayrollRows(
      [
        { id: "d1", name: "Low", employee_number: null, trips: [trip({ incentive_earned: 10 })] },
        {
          id: "d2",
          name: "High",
          employee_number: null,
          trips: [
            trip({
              id: "later",
              pickup_datetime: new Date("2026-07-20T01:00:00Z"),
              delivered_at: new Date("2026-07-20T05:00:00Z"),
            }),
            trip({
              id: "earlier",
              pickup_datetime: new Date("2026-07-05T01:00:00Z"),
              delivered_at: new Date("2026-07-05T05:00:00Z"),
            }),
          ],
        },
      ],
      JULY
    );
    expect(rows.map((r) => r.name)).toEqual(["High", "Low"]);
    expect(rows[0].trips.map((t) => t.id)).toEqual(["earlier", "later"]);
  });
});
