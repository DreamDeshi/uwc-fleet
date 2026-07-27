import { describe, expect, it } from "vitest";
import { buildFuelLogsCsv, buildFuelSummaryCsv } from "./fuelCsv";
import type { TruckFuelSummary } from "../types";

describe("buildFuelLogsCsv", () => {
  it("one row per fill, date-only, blanks for missing fields", () => {
    const csv = buildFuelLogsCsv([
      {
        logged_at: "2026-07-21T03:15:00.000Z",
        truck_plate: "PLX 2406",
        driver_name: "Mohd Azmi",
        liters: 145.2,
        cost: 428.34,
        odometer: 182300,
      },
      { logged_at: "2026-07-22T03:15:00.000Z", truck_plate: "PRH 5292", driver_name: null, liters: 41.5, cost: 122.4, odometer: null },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Date,Truck,Driver,Litres,Cost (RM),Odometer (km)");
    expect(lines[1]).toBe("2026-07-21,PLX 2406,Mohd Azmi,145.2,428.34,182300");
    expect(lines[2]).toBe("2026-07-22,PRH 5292,,41.5,122.4,");
  });
});

describe("buildFuelSummaryCsv", () => {
  it("one row per truck with the Costing columns", () => {
    const row = {
      plate: "PLX 2406",
      type: "10t-30ft",
      log_count: 2,
      total_litres: 298,
      total_cost_rm: 879.1,
      avg_cost_per_litre: 2.95,
      total_km_covered: 490,
      cost_per_km: 1.79,
      litres_per_100km: 60.82,
      co2e_kg: 798.64,
      co2e_kg_per_km: 1.63,
    } as TruckFuelSummary;
    const lines = buildFuelSummaryCsv([row]).split("\n");
    expect(lines[0]).toBe("Truck,Type,Fills,Litres,Cost (RM),Distance (km),Cost/km (RM),L/100km,CO2e (kg)");
    expect(lines[1]).toBe("PLX 2406,10t-30ft,2,298,879.1,490,1.79,60.82,798.64");
  });
});
