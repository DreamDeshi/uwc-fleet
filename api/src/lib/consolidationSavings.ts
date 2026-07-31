import { numberFromEnv } from "./envNumbers";
/**
 * Consolidation ("empty-mile") savings — a sustainability KPI.
 *
 * When one trip carries several drops, every drop BEYOND the first is a delivery
 * that did NOT need its own trip. That count is EXACT (drops − trips). Turning it
 * into km / fuel / CO2 needs a per-trip distance the system doesn't record, so
 * those are ESTIMATES from tunable averages and MUST be labelled as such in the
 * UI. Pure (no DB) so it is unit-testable. Never touches pay or dispatch.
 *
 * ── A "DROP" IS A STOP THAT WAS ACTUALLY DELIVERED ──────────────────────────
 *
 * Not a stop that was PLANNED. The caller used to pass `Trip._count.stops`, the
 * whole itinerary, which over-claimed on every trip that ended early:
 *
 *   A three-stop run delivers the first drop, the lorry breaks down, the admin
 *   aborts. The abort's partial-pay path finalizes to `pending_approval` and
 *   approval flips it to `completed`, with the two stops the driver never
 *   reached left `pending` (services/tripAssignment + the abort branch in
 *   routes/trips). One delivery happened. The KPI claimed two avoided journeys,
 *   70 km and 56 kg of CO2e that nobody ever saved.
 *
 * That is reachable today with no feature flag, which is why the predicate now
 * lives in the caller's `where` and is spelled out here: the phrase "delivered"
 * is load-bearing, not descriptive.
 *
 * DELIBERATELY CONSERVATIVE, both ways. A stop the driver reached but could not
 * hand over (the exception path's paid-undelivered stop) is a journey the truck
 * genuinely made, and it is NOT counted — the KPI under-claims rather than
 * import a money predicate (services/undeliveredPay) into a sustainability
 * report. Those two vocabularies have been confused here before and it cost
 * real money; a slightly small green number is the cheaper mistake.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ConsolidationConfig {
  kmPerDelivery: number; // assumed extra distance a standalone delivery would add
  litresPer100km: number; // assumed fleet consumption
  co2ePerLitre: number; // diesel tailpipe factor
}


export function defaultConsolidationConfig(): ConsolidationConfig {
  return {
    kmPerDelivery: numberFromEnv("EST_KM_PER_DELIVERY", 35),
    litresPer100km: numberFromEnv("EST_L_PER_100KM", 30),
    co2ePerLitre: numberFromEnv("FUEL_CO2E_KG_PER_LITRE", 2.68),
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

/**
 * Roll up two TOTALS into savings: how many trips delivered anything, and how
 * many drops they delivered between them.
 *
 * Totals rather than a per-trip array because the caller counts them with two
 * scalar `COUNT(*)`s. It used to `findMany` every completed trip ever and sum in
 * Node — an unbounded fetch behind the admin DASHBOARD, which loads it on every
 * visit. The arithmetic only ever needed the two sums.
 *
 * `trips` MUST be the count of trips that delivered at least one drop, or a
 * trip that delivered none would subtract a real saving from the total. The
 * floor below is a backstop for that, not a licence to pass anything.
 */
export function consolidationSavingsFromTotals(
  trips: number,
  drops: number,
  cfg: ConsolidationConfig = defaultConsolidationConfig()
): ConsolidationSavings {
  const tripsSaved = Math.max(drops - trips, 0);
  const estKmSaved = tripsSaved * cfg.kmPerDelivery;
  const estLitresSaved = round2((estKmSaved * cfg.litresPer100km) / 100);
  const estCo2eKgSaved = round2(estLitresSaved * cfg.co2ePerLitre);
  return { trips, drops, tripsSaved, estKmSaved, estLitresSaved, estCo2eKgSaved };
}

/** The same roll-up from a per-trip list of DELIVERED-drop counts. */
export function consolidationSavings(
  tripDeliveredCounts: number[],
  cfg: ConsolidationConfig = defaultConsolidationConfig()
): ConsolidationSavings {
  return consolidationSavingsFromTotals(
    tripDeliveredCounts.length,
    tripDeliveredCounts.reduce((s, n) => s + n, 0),
    cfg
  );
}
