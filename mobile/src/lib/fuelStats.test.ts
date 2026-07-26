import { describe, expect, it } from "vitest";
import { monthFuelTotals } from "./fuelStats";

const NOW = new Date(2026, 6, 27, 12, 0, 0); // 27 July 2026, local

describe("monthFuelTotals", () => {
  it("sums only the current local month, coercing Decimal strings", () => {
    const totals = monthFuelTotals(
      [
        { liters: "80.5", cost: "260.00", logged_at: new Date(2026, 6, 3).toISOString() },
        { liters: 60, cost: 195.5, logged_at: new Date(2026, 6, 20).toISOString() },
        { liters: "999", cost: "999", logged_at: new Date(2026, 5, 30).toISOString() }, // June — out
      ],
      NOW
    );
    expect(totals).toEqual({ fills: 2, litres: 140.5, costRm: 455.5 });
  });

  it("returns zeros on an empty month", () => {
    expect(monthFuelTotals([], NOW)).toEqual({ fills: 0, litres: 0, costRm: 0 });
  });
});
