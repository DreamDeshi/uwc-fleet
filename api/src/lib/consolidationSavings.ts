/**
 * Consolidation ("empty-mile") savings — a sustainability KPI.
 *
 * When one trip carries several drops, every drop BEYOND the first is a delivery
 * that did NOT need its own trip. That count is EXACT (drops − trips). Turning it
 * into km / fuel / CO2 needs a per-trip distance the system doesn't record, so
 * those are ESTIMATES from tunable averages and MUST be labelled as such in the
 * UI. Pure (no DB) so it is unit-testable. Never touches pay or dispatch.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ConsolidationConfig {
  kmPerDelivery: number; // assumed extra distance a standalone delivery would add
  litresPer100km: number; // assumed fleet consumption
  co2ePerLitre: number; // diesel tailpipe factor
}

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultConsolidationConfig(): ConsolidationConfig {
  return {
    kmPerDelivery: numEnv("EST_KM_PER_DELIVERY", 35),
    litresPer100km: numEnv("EST_L_PER_100KM", 30),
    co2ePerLitre: numEnv("FUEL_CO2E_KG_PER_LITRE", 2.68),
  };
}

export interface ConsolidationSavings {
  trips: number;
  drops: number;
  /** EXACT: extra drops that shared a trip instead of each needing its own. */
  tripsSaved: number;
  /** ESTIMATES (from ConsolidationConfig averages) — label as estimates in the UI. */
  estKmSaved: number;
  estLitresSaved: number;
  estCo2eKgSaved: number;
}

/** Roll up completed trips (each given by its delivered-stop count) into savings. */
export function consolidationSavings(
  tripStopCounts: number[],
  cfg: ConsolidationConfig = defaultConsolidationConfig()
): ConsolidationSavings {
  const trips = tripStopCounts.length;
  const drops = tripStopCounts.reduce((s, n) => s + n, 0);
  const tripsSaved = Math.max(drops - trips, 0);
  const estKmSaved = tripsSaved * cfg.kmPerDelivery;
  const estLitresSaved = round2((estKmSaved * cfg.litresPer100km) / 100);
  const estCo2eKgSaved = round2(estLitresSaved * cfg.co2ePerLitre);
  return { trips, drops, tripsSaved, estKmSaved, estLitresSaved, estCo2eKgSaved };
}
