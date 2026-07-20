// Server-side geography helpers for Phase 5 (GPS + live location).
//
// The schema stores consignees by zone, not lat/long, so until we geocode real
// addresses the destination of a trip is approximated by its zone centroid.
// These coordinates mirror the mobile app's lib/geo.ts so both ends agree.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * THE UWC plant — origin of every trip, and the ONLY plant coordinate in the
 * API. Feeds estimateTripDistanceKm() (driver Earnings km, admin Performance
 * "km this month") and the "PLANT" end of every pre-computed RouteLeg.
 *
 * Geocoded from the documented address:
 *   PMT 744, Jalan Cassia Selatan 5/1, Batu Kawan (Simpang Ampat)
 * which comes from the YS workbook's "CONSIGNEE and CONSIGNOR" sheet — the same
 * sheet that seeds the UWC BERHAD (P1)..(P9) pickup rows. It is a REAL surveyed
 * value, not an eyeballed pin.
 *
 * ⚠ Do NOT "correct" this to a rounder-looking number. It replaced 5.466/100.43
 * (2026-07-20), which sat NORTH of Juru (P2, 5.35) — nowhere near Batu Kawan —
 * and understated P3/K2 round trips by ~37-39 km while overstating the
 * long-haul zones by ~35-39 km. Distance has never touched pay (no service
 * imports this module; the incentive engine is points-only), and no km value is
 * persisted, so fixing the constant corrects historical figures on next read.
 *
 * ⚠ The mobile app keeps its own copy of this literal in `mobile/src/lib/geo.ts`
 * — the two packages deploy from separate Railway root directories and cannot
 * import across the boundary. THEY MUST STAY EQUAL: change one, change the other.
 */
export const PLANT_ORIGIN: LatLng = { latitude: 5.216238509805299, longitude: 100.4445982584094 };

export const ZONE_COORDS: Record<string, LatLng> = {
  P1: { latitude: 5.4145, longitude: 100.3292 }, // Penang Island
  P2: { latitude: 5.35, longitude: 100.4 }, // Juru & Perai
  P3: { latitude: 5.5333, longitude: 100.4833 }, // Tasek Gelugor
  K1: { latitude: 5.365, longitude: 100.561 }, // Kulim
  K2: { latitude: 5.647, longitude: 100.487 }, // Sungai Petani / Kuala Ketil
  A1: { latitude: 4.85, longitude: 100.7333 }, // Taiping
  A2: { latitude: 4.5975, longitude: 101.0901 }, // Ipoh
  KL: { latitude: 3.139, longitude: 101.6869 }, // Kuala Lumpur (city centre)
};

export function zoneCoord(zoneCode?: string | null): LatLng {
  if (zoneCode && ZONE_COORDS[zoneCode]) return ZONE_COORDS[zoneCode];
  return { latitude: 5.4, longitude: 100.4 }; // fallback: somewhere over Penang mainland
}

// Great-circle distance in km. Used to estimate trip distance from zone
// centroids for the earnings/performance figures — deliberately NOT the road
// distance in RouteLeg, which covers only plant→zone legs, not round trips.
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rough round-trip distance for a delivery to `zoneCode` (plant → zone → plant).
// An estimate for the driver's earnings summary, not a billing figure.
export function estimateTripDistanceKm(zoneCode?: string | null): number {
  const oneWay = haversineKm(PLANT_ORIGIN, zoneCoord(zoneCode));
  return Math.round(oneWay * 2);
}

export interface RouteResult {
  polyline: LatLng[];
  distance_m: number | null;
  duration_s: number | null;
  // "precomputed" = real road geometry from the RouteLeg table (generated
  // offline by a local OpenRouteService — see services/routeLegs.ts).
  // "straight"    = the fallback line, used when a leg is missing or stale.
  source: "precomputed" | "straight";
}

/**
 * The fallback: a plain line through the given points. Used whenever real
 * geometry isn't available, so the map ALWAYS renders something. Distance and
 * duration are null rather than a straight-line guess — a wrong number is worse
 * than an absent one, and the UI already treats null as "not known".
 */
export function straightRoute(points: LatLng[]): RouteResult {
  return { polyline: points, distance_m: null, duration_s: null, source: "straight" };
}

// Decode Google's "encoded polyline" string into a list of lat/lng points.
// Reference algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}
