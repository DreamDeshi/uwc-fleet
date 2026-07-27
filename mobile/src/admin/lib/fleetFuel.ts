// Fleet-wide fuel / carbon rollup — shared by the Trucks → Fuel headline
// strip and the dashboard sustainability tile so both always show the same
// numbers. Distance-weighted: fleet L/100km is fleet litres ÷ fleet km × 100,
// never an average of per-truck rates (which would misweight short-haul
// trucks). Figures come from the server's summariseFuel (actual logged
// fill-ups + odometer spans); CO₂e uses the server's DEFRA/EPA diesel factor.
import type { TruckFuelSummary } from "../types";

export interface FleetFuelRollup {
  /** Total litres logged this period, 1 dp. */
  litres: number;
  /** Total odometer-span distance, km. */
  km: number;
  /** Total estimated CO₂e, kg, 1 dp. */
  co2e: number;
  /** Distance-weighted fleet L/100km, 1 dp; null when no distance. */
  lp100: number | null;
  hasData: boolean;
}

export function fleetFuelRollup(rows: TruckFuelSummary[]): FleetFuelRollup {
  const litres = rows.reduce((s, x) => s + x.total_litres, 0);
  const km = rows.reduce((s, x) => s + x.total_km_covered, 0);
  const co2e = rows.reduce((s, x) => s + x.co2e_kg, 0);
  return {
    litres: Math.round(litres * 10) / 10,
    km,
    co2e: Math.round(co2e * 10) / 10,
    lp100: km > 0 ? Math.round((litres / km) * 100 * 10) / 10 : null,
    hasData: rows.some((x) => x.log_count > 0),
  };
}
