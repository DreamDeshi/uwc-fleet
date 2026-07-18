import { describe, it, expect } from "vitest";
import { summariseFuel, DIESEL_CO2E_KG_PER_LITRE } from "../src/lib/fuelSummary";

describe("summariseFuel — spend + efficiency + carbon", () => {
  it("uses the standard diesel factor by default (2.68 kg CO2e/L)", () => {
    expect(DIESEL_CO2E_KG_PER_LITRE).toBe(2.68);
  });

  it("two fills with odometer readings → full efficiency + carbon figures", () => {
    const s = summariseFuel([
      { liters: 60, cost: 240, odometer: 1000 },
      { liters: 40, cost: 160, odometer: 1500 },
    ]);
    expect(s.total_litres).toBe(100);
    expect(s.total_cost_rm).toBe(400);
    expect(s.total_km_covered).toBe(500); // odometer span 1500 − 1000
    expect(s.avg_cost_per_litre).toBe(4); // 400 / 100
    expect(s.cost_per_km).toBe(0.8); // 400 / 500
    expect(s.litres_per_100km).toBe(20); // 100 / 500 × 100
    expect(s.co2e_kg).toBe(268); // 100 × 2.68
    expect(s.co2e_kg_per_km).toBe(0.54); // 268 / 500, rounded to 2dp
  });

  it("a single fill → CO2e (needs only litres) but no distance-based rates", () => {
    const s = summariseFuel([{ liters: 50, cost: 200, odometer: 1000 }]);
    expect(s.co2e_kg).toBe(134); // 50 × 2.68 — defined without distance
    expect(s.total_km_covered).toBe(0); // one odometer reading is not a span
    expect(s.litres_per_100km).toBeNull();
    expect(s.cost_per_km).toBeNull();
    expect(s.co2e_kg_per_km).toBeNull();
  });

  it("no logs → zeros and nulls (no division by zero)", () => {
    const s = summariseFuel([]);
    expect(s.total_litres).toBe(0);
    expect(s.co2e_kg).toBe(0);
    expect(s.litres_per_100km).toBeNull();
    expect(s.co2e_kg_per_km).toBeNull();
    expect(s.avg_cost_per_litre).toBeNull();
  });

  it("logs missing odometers still report spend + carbon, no efficiency", () => {
    const s = summariseFuel([
      { liters: 30, cost: 120, odometer: null },
      { liters: 20, cost: 80, odometer: null },
    ]);
    expect(s.total_litres).toBe(50);
    expect(s.co2e_kg).toBe(134); // 50 × 2.68
    expect(s.total_km_covered).toBe(0);
    expect(s.litres_per_100km).toBeNull();
  });
});
