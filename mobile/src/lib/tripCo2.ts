// Per-trip CO₂e ESTIMATE for completed trip/booking details — the fleet's
// sustainability story told one delivery at a time (SDG visibility).
//
// Distance = round trip plant → FARTHEST stop, using the consignee's
// geocoded building when it has one and the zone centroid otherwise (same
// presence-of-coords gate as everywhere else). That is an ESTIMATE and the
// UI must label it so. ⚠ The consumption/emission constants MIRROR the
// api's display-only estimate constants (EST_L_PER_100KM=30,
// FUEL_CO2E_KG_PER_LITRE=2.68 in api/src/lib/consolidationSavings.ts) —
// keep the two in step. Display only: never pay, never dispatch.
import { PLANT_ORIGIN, haversineKm, consigneeDestination, zoneCoord } from "./geo";

export const EST_L_PER_100KM = 30;
export const EST_CO2E_KG_PER_LITRE = 2.68;

export interface TripCo2Estimate {
  km: number;
  co2Kg: number;
}

interface StopLike {
  consignee?: {
    latitude?: number | null;
    longitude?: number | null;
    zone_code: string;
  } | null;
}

export function estimateTripCo2(stops: StopLike[], fallbackZone?: string | null): TripCo2Estimate | null {
  const coords = stops
    .map((s) => (s.consignee ? consigneeDestination(s.consignee).coord : null))
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (coords.length === 0 && fallbackZone) coords.push(zoneCoord(fallbackZone));
  if (coords.length === 0) return null;

  let farthest = 0;
  for (const c of coords) {
    const d = haversineKm(PLANT_ORIGIN, c);
    if (d > farthest) farthest = d;
  }
  const km = Math.round(farthest * 2);
  if (km <= 0) return null;
  const litres = (km * EST_L_PER_100KM) / 100;
  return { km, co2Kg: Math.round(litres * EST_CO2E_KG_PER_LITRE * 10) / 10 };
}
