// Fuel CSV builders for the Sustainability screen exports. Owner direction
// (27 Jul): SEPARATE single-purpose files, not one mega-export — a fills
// ledger (one row per fill-up) and a monthly per-truck summary. Same Excel
// conventions as the payroll export: RFC-4180 cells via lib/csv (injection-
// guarded), plain numbers without currency symbols, caller prepends CSV_BOM.
import { toCsv } from "./csv";
import type { TruckFuelSummary } from "../types";

export interface FuelLogExportRow {
  logged_at: string;
  truck_plate: string;
  driver_name: string | null;
  liters: number;
  cost: number;
  odometer: number | null;
}

export function buildFuelLogsCsv(logs: FuelLogExportRow[]): string {
  return toCsv([
    ["Date", "Truck", "Driver", "Litres", "Cost (RM)", "Odometer (km)"],
    ...logs.map((l) => [
      l.logged_at.slice(0, 10),
      l.truck_plate,
      l.driver_name ?? "",
      l.liters,
      l.cost,
      l.odometer ?? "",
    ]),
  ]);
}

export function buildFuelSummaryCsv(rows: TruckFuelSummary[]): string {
  return toCsv([
    ["Truck", "Type", "Fills", "Litres", "Cost (RM)", "Distance (km)", "Cost/km (RM)", "L/100km", "CO2e (kg)"],
    ...rows.map((r) => [
      r.plate,
      r.type,
      r.log_count,
      r.total_litres,
      r.total_cost_rm,
      r.total_km_covered,
      r.cost_per_km ?? "",
      r.litres_per_100km ?? "",
      r.co2e_kg,
    ]),
  ]);
}
