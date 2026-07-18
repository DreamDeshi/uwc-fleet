/**
 * Fuel-log rollup + carbon/efficiency metrics (fuel dashboard, FR-CT5).
 *
 * Pure (no DB, no Date.now()) so it is unit-testable. Extends the original spend
 * summary with fuel EFFICIENCY (litres per 100 km) and CARBON (CO2e), both
 * derived from the SAME litres + odometer the spend figures already use.
 * Display/reporting only — never read by the incentive or dispatch paths.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tailpipe CO2 for diesel: ~2.68 kg CO2e per litre burned — the standard
 * DEFRA/EPA factor for diesel fuel (the UWC fleet is diesel lorries).
 * Env-tunable via FUEL_CO2E_KG_PER_LITRE for a different fuel mix or an updated
 * emission factor; never used in any pay or dispatch calculation.
 */
export const DIESEL_CO2E_KG_PER_LITRE = (() => {
  const raw = process.env.FUEL_CO2E_KG_PER_LITRE;
  const n = raw != null && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2.68;
})();

export interface FuelSummary {
  log_count: number;
  total_litres: number;
  total_cost_rm: number;
  avg_cost_per_litre: number | null;
  total_km_covered: number;
  cost_per_km: number | null;
  /** Fuel efficiency: litres per 100 km over the odometer span (null when km unknown). */
  litres_per_100km: number | null;
  /** Estimated tailpipe carbon for the litres burned, kilograms CO2e. */
  co2e_kg: number;
  /** CO2e per km over the odometer span (null when km unknown). */
  co2e_kg_per_km: number | null;
}

/**
 * Roll a set of fuel logs into the spend + efficiency + carbon summary.
 * `total_km_covered` is the odometer span (max − min) across logs that recorded
 * an odometer; every per-km / per-litre figure is null when its denominator is
 * zero, so a truck with fewer than two odometer readings shows spend + CO2e
 * (which need only litres) but no efficiency rates.
 */
export function summariseFuel(
  logs: { liters: unknown; cost: unknown; odometer: number | null }[]
): FuelSummary {
  const total_litres = round2(logs.reduce((s, l) => s + Number(l.liters), 0));
  const total_cost_rm = round2(logs.reduce((s, l) => s + Number(l.cost), 0));
  const odos = logs.map((l) => l.odometer).filter((o): o is number => o != null);
  const total_km_covered = odos.length >= 2 ? Math.max(...odos) - Math.min(...odos) : 0;
  // CO2e needs only litres, so it is defined even for a single fill; the
  // efficiency rates need distance and stay null until two odometer readings.
  const co2e_kg = round2(total_litres * DIESEL_CO2E_KG_PER_LITRE);
  return {
    log_count: logs.length,
    total_litres,
    total_cost_rm,
    avg_cost_per_litre: total_litres > 0 ? round2(total_cost_rm / total_litres) : null,
    total_km_covered,
    cost_per_km: total_km_covered > 0 ? round2(total_cost_rm / total_km_covered) : null,
    litres_per_100km: total_km_covered > 0 ? round2((total_litres / total_km_covered) * 100) : null,
    co2e_kg,
    co2e_kg_per_km: total_km_covered > 0 ? round2(co2e_kg / total_km_covered) : null,
  };
}
