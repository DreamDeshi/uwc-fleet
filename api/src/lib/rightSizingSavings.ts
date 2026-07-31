import { numberFromEnv } from "./envNumbers";
/**
 * Right-sizing ("smallest-fit") fuel savings — a sustainability KPI.
 *
 * Auto-dispatch always picks the SMALLEST truck that fits the load
 * (dispatchEngine.selectTruck, Rule A). This estimates the fuel that choice
 * avoided burning versus a counterfactual where every load went out on the
 * fleet's largest truck class. The right-sized trip count is EXACT; the
 * litres/CO2 figures are ESTIMATES from tunable per-class consumption
 * averages and MUST be labelled as estimates in the UI. Pure (no DB) so it
 * is unit-testable. Never touches pay or dispatch.
 *
 * ⚠ INVENTED CONSTANTS — the per-class L/100km defaults and the per-trip
 * distance are OUR OWN engineering estimates (typical loaded diesel
 * consumption per GVW class on Malaysian urban/regional duty; ~35 km per
 * run around the Batu Kawan catchment), NOT client-specified figures.
 * Deliberately conservative: distance counts once per TRIP, not per drop,
 * and unknown truck classes claim nothing — the KPI under-claims. Registered
 * in the root .env.example alongside the consolidation estimate constants.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RightSizingConfig {
  /** Assumed loaded consumption per truck class, L/100km. */
  l100ByClass: Record<string, number>;
  /** Assumed average distance of one trip, km. */
  kmPerTrip: number;
  /** Diesel tailpipe factor, kg CO2e per litre. */
  co2ePerLitre: number;
}


export function defaultRightSizingConfig(): RightSizingConfig {
  return {
    l100ByClass: {
      "10t": numberFromEnv("EST_L100_10T", 32),
      "5t": numberFromEnv("EST_L100_5T", 22),
      "1t": numberFromEnv("EST_L100_1T", 12),
    },
    kmPerTrip: numberFromEnv("EST_KM_PER_TRIP", 35),
    co2ePerLitre: numberFromEnv("FUEL_CO2E_KG_PER_LITRE", 2.68),
  };
}

/**
 * Truck.type is a free-text label ("10t-30ft", "5t-17.5ft", "1t", "Generic").
 * The tonnage prefix is the consumption class; anything without one ("Generic",
 * null) maps to null and contributes no savings.
 */
export function truckClass(type: string | null | undefined): string | null {
  if (!type) return null;
  const m = /^(\d+(?:\.\d+)?t)/i.exec(type.trim());
  return m ? m[1].toLowerCase() : null;
}

export interface RightSizingSavings {
  /** Trips considered (internal, truck assigned, this month). */
  trips: number;
  /** EXACT: trips that ran on a smaller class than the fleet's largest. */
  tripsRightSized: number;
  /** ESTIMATE (from RightSizingConfig averages) — label as estimate in the UI. */
  estLitresSaved: number;
  /** ESTIMATE — label as estimate in the UI. */
  estCo2eKgSaved: number;
}

export function rightSizingSavings(
  truckTypes: (string | null)[],
  largestType: string | null,
  cfg: RightSizingConfig = defaultRightSizingConfig()
): RightSizingSavings {
  const largestClass = truckClass(largestType);
  const largestL100 = largestClass != null ? cfg.l100ByClass[largestClass] : undefined;
  let litres = 0;
  let rightSized = 0;
  for (const type of truckTypes) {
    if (largestL100 === undefined) break;
    const cls = truckClass(type);
    if (cls == null) continue;
    const l100 = cfg.l100ByClass[cls];
    if (l100 === undefined || l100 >= largestL100) continue;
    rightSized += 1;
    litres += (cfg.kmPerTrip * (largestL100 - l100)) / 100;
  }
  const estLitresSaved = round2(litres);
  return {
    trips: truckTypes.length,
    tripsRightSized: rightSized,
    estLitresSaved,
    estCo2eKgSaved: round2(estLitresSaved * cfg.co2ePerLitre),
  };
}
