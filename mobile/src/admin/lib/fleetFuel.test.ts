import { describe, expect, it } from "vitest";
import { fleetFuelRollup } from "./fleetFuel";
import type { TruckFuelSummary } from "../types";

function makeRow(over: Partial<TruckFuelSummary>): TruckFuelSummary {
  return {
    plate: "PLX 2406",
    type: "10t-30ft",
    log_count: 1,
    total_litres: 0,
    total_cost_rm: 0,
    avg_cost_per_litre: null,
    total_km_covered: 0,
    cost_per_km: null,
    litres_per_100km: null,
    co2e_kg: 0,
    co2e_kg_per_km: null,
    ...over,
  } as TruckFuelSummary;
}

describe("fleetFuelRollup", () => {
  it("sums litres, km and co2e across trucks", () => {
    const r = fleetFuelRollup([
      makeRow({ total_litres: 100, total_km_covered: 1000, co2e_kg: 268 }),
      makeRow({ plate: "PND 1888", total_litres: 50.55, total_km_covered: 500, co2e_kg: 135.474 }),
    ]);
    expect(r.litres).toBe(150.6);
    expect(r.km).toBe(1500);
    expect(r.co2e).toBe(403.5);
    expect(r.hasData).toBe(true);
  });

  it("weights fleet L/100km by distance, not by averaging per-truck rates", () => {
    // Truck A: 10 L/100km over 1000 km; Truck B: 30 L/100km over 1000 km.
    // Naive average of rates = 20 only because distances are equal; skew the
    // distances and the naive average (20) diverges from the true fleet rate.
    const r = fleetFuelRollup([
      makeRow({ total_litres: 100, total_km_covered: 1000 }),
      makeRow({ plate: "PND 1888", total_litres: 30, total_km_covered: 100 }),
    ]);
    // 130 L over 1100 km = 11.8 L/100km, NOT (10+30)/2 = 20.
    expect(r.lp100).toBe(11.8);
  });

  it("returns null L/100km when there is no distance", () => {
    const r = fleetFuelRollup([makeRow({ total_litres: 80, total_km_covered: 0 })]);
    expect(r.lp100).toBeNull();
  });

  it("is empty-safe and reports hasData=false with no logs", () => {
    expect(fleetFuelRollup([])).toEqual({ litres: 0, km: 0, co2e: 0, lp100: null, hasData: false });
    const zeroLogs = fleetFuelRollup([makeRow({ log_count: 0 })]);
    expect(zeroLogs.hasData).toBe(false);
  });
});
