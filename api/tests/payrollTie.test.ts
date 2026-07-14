import { describe, it, expect } from "vitest";
import { buildPayrollRows, type PayrollDriverInput } from "../src/services/payroll";
import { mytMonthBoundsForKey } from "../src/lib/myt";

/**
 * Phase 1 (MONEY) — exact-tie ordering on the month-end payroll sheet.
 *
 * buildPayrollRows sorts by month total descending. Array.prototype.sort is
 * STABLE (V8 / ES2019+), so two drivers with equal totals keep the order they
 * arrived in — i.e. there is NO secondary tiebreak (name/employee number). The
 * ordering of a tie is therefore whatever the CALLER passes in.
 *
 * These tests lock that behaviour. They also make the flagged watch-item visible
 * (Phase 0 audit): the payroll ROUTE must feed drivers in a deterministic order
 * for month-end sheets to be reproducible across runs — the pure function alone
 * does not impose one. (Flagged, not changed — this is a test, not a fix.)
 */

const JULY = mytMonthBoundsForKey("2026-07")!;

// A July trip carrying a given stored pay. pickup_datetime lands the trip in
// the July bounds; incentive_earned is the stored per-trip marginal.
function driver(id: string, name: string, total: number): PayrollDriverInput {
  return {
    id,
    name,
    employee_number: null,
    trips: [
      {
        id: `${id}-t`,
        ticket_number: `TKT-${id}`,
        pickup_datetime: new Date("2026-07-10T01:00:00Z"),
        delivered_at: new Date("2026-07-10T05:00:00Z"),
        incentive_earned: total,
      },
    ],
  };
}

describe("buildPayrollRows — exact-tie ordering", () => {
  it("sorts by total desc; a non-tied top earner always leads", () => {
    const rows = buildPayrollRows(
      [driver("a", "Amir", 50), driver("b", "Bala", 50), driver("c", "Chong", 100)],
      JULY
    );
    expect(rows.map((r) => r.total)).toEqual([100, 50, 50]);
    expect(rows[0].driver_id).toBe("c");
  });

  it("resolves an exact tie by preserving the CALLER's input order (stable sort, no secondary key)", () => {
    // Same two 50-total drivers, opposite input orders → the tie mirrors input.
    const ab = buildPayrollRows([driver("a", "Amir", 50), driver("b", "Bala", 50)], JULY);
    expect(ab.map((r) => r.driver_id)).toEqual(["a", "b"]);

    const ba = buildPayrollRows([driver("b", "Bala", 50), driver("a", "Amir", 50)], JULY);
    expect(ba.map((r) => r.driver_id)).toEqual(["b", "a"]);
  });

  it("keeps the tie stable even around a higher earner in the middle of the list", () => {
    const rows = buildPayrollRows(
      [driver("a", "Amir", 50), driver("c", "Chong", 100), driver("b", "Bala", 50)],
      JULY
    );
    // Chong (100) first; the 50-ties keep their relative input order (a before b).
    expect(rows.map((r) => r.driver_id)).toEqual(["c", "a", "b"]);
  });
});
