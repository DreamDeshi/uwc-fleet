import { describe, it, expect } from "vitest";
import { buildPayrollRows, type PayrollDriverInput } from "../src/services/payroll";
import { mytMonthBoundsForKey } from "../src/lib/myt";

/**
 * Exact-tie ordering on the month-end payroll sheet — the formerly flagged
 * watch-item, now FIXED: buildPayrollRows sorts by total desc with
 * deterministic tiebreaks (name, then employee number, then driver id, all
 * binary compares). Identical inputs produce an identical sheet no matter what
 * order the route feeds drivers in.
 */

const JULY = mytMonthBoundsForKey("2026-07")!;

// A July trip carrying a given stored pay. pickup_datetime lands the trip in
// the July bounds; incentive_earned is the stored per-trip marginal.
function driver(
  id: string,
  name: string,
  total: number,
  employee_number: string | null = null
): PayrollDriverInput {
  return {
    id,
    name,
    employee_number,
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

describe("buildPayrollRows — deterministic exact-tie ordering", () => {
  it("sorts by total desc; a non-tied top earner always leads", () => {
    const rows = buildPayrollRows(
      [driver("a", "Amir", 50), driver("b", "Bala", 50), driver("c", "Chong", 100)],
      JULY
    );
    expect(rows.map((r) => r.total)).toEqual([100, 50, 50]);
    expect(rows[0].driver_id).toBe("c");
  });

  it("resolves an exact tie by NAME regardless of the caller's input order", () => {
    // Same two 50-total drivers, opposite input orders → identical output.
    const ab = buildPayrollRows([driver("a", "Amir", 50), driver("b", "Bala", 50)], JULY);
    const ba = buildPayrollRows([driver("b", "Bala", 50), driver("a", "Amir", 50)], JULY);
    expect(ab.map((r) => r.driver_id)).toEqual(["a", "b"]); // Amir < Bala
    expect(ba.map((r) => r.driver_id)).toEqual(["a", "b"]); // input order irrelevant
  });

  it("orders ties deterministically around a higher earner too", () => {
    const rows = buildPayrollRows(
      [driver("b", "Bala", 50), driver("c", "Chong", 100), driver("a", "Amir", 50)],
      JULY
    );
    expect(rows.map((r) => r.driver_id)).toEqual(["c", "a", "b"]);
  });

  it("same name falls through to employee number, then driver id", () => {
    // Two "Amir"s: employee number decides; missing numbers sort first ("" < any).
    const byEmp = buildPayrollRows(
      [driver("x", "Amir", 50, "E-2"), driver("y", "Amir", 50, "E-1")],
      JULY
    );
    expect(byEmp.map((r) => r.driver_id)).toEqual(["y", "x"]);

    // Identical name + employee number: driver id is the final, always-unique key.
    const byId = buildPayrollRows(
      [driver("z2", "Amir", 50, "E-1"), driver("z1", "Amir", 50, "E-1")],
      JULY
    );
    expect(byId.map((r) => r.driver_id)).toEqual(["z1", "z2"]);
  });
});
