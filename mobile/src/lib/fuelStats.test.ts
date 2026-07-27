import { describe, expect, it } from "vitest";
import { daysSinceFill, fuelLogNudge, FUEL_NUDGE_AFTER_DAYS, monthFuelTotals } from "./fuelStats";

const NUDGE_NOW = new Date("2026-07-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NUDGE_NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

describe("fuel nudge", () => {
  it("counts whole days since the last fill", () => {
    expect(daysSinceFill(daysAgo(0), NUDGE_NOW)).toBe(0);
    expect(daysSinceFill(daysAgo(4), NUDGE_NOW)).toBe(4);
    expect(daysSinceFill(null, NUDGE_NOW)).toBeNull();
    expect(daysSinceFill("garbage", NUDGE_NOW)).toBeNull();
  });

  it("nudges when never logged or at/after the threshold, not before", () => {
    expect(fuelLogNudge(null, NUDGE_NOW)).toBe(true);
    expect(fuelLogNudge(daysAgo(FUEL_NUDGE_AFTER_DAYS), NUDGE_NOW)).toBe(true);
    expect(fuelLogNudge(daysAgo(FUEL_NUDGE_AFTER_DAYS - 1), NUDGE_NOW)).toBe(false);
    expect(fuelLogNudge(daysAgo(0), NUDGE_NOW)).toBe(false);
  });
});

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
