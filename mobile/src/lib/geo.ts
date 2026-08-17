// Map + navigation geometry. Consignees ARE geocoded (offline, by
// scripts/geocode-google.ts), so a destination is the consignee's own stored
// coordinate where one exists — see `consigneeDestination`. 1,160 of 1,564 had
// one at the last production read (18 Aug 2026). The zone centroids below are
// the fallback for the rest, and still frame the map. Distances here stay
// straight-line and are labelled approximate.
//
// ⚠ A STORED COORDINATE IS NO LONGER ALWAYS A BUILDING. This comment used to
// say "building coordinate", which was true while the write gate kept ROOFTOP
// and RANGE_INTERPOLATED only. It now also stores a street centre, a postcode
// centre and a shared pin, because the alternative was a zone centroid a median
// of 7.3 km away. HOW GOOD a pin is travels with the row and is read through
// `api/src/lib/geocodePrecision.ts` — building / road / area / unknown.
//
// For NAVIGATION the grade does not change what we do: any pin beats the
// centroid. It matters for what we CLAIM — `Destination.precise` below is still
// a two-state flag and is therefore coarser than the data, which is the
// outstanding wording work, not a defect in the position itself.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * THE UWC plant — origin of every trip, and the ONLY plant coordinate in the
 * mobile app. `admin/lib/zones.ts` imports this one; do not add another.
 *
 * Geocoded from the documented address:
 *   PMT 744, Jalan Cassia Selatan 5/1, Batu Kawan (Simpang Ampat)
 * which comes from the YS workbook's "CONSIGNEE and CONSIGNOR" sheet — the same
 * sheet that seeds the UWC BERHAD (P1)..(P9) pickup rows. It is a REAL surveyed
 * value, not an eyeballed pin.
 *
 * ⚠ Do NOT "correct" this to a rounder-looking number. It replaced two
 * conflicting guesses (2026-07-20): 5.2837/100.4577 here in the admin map and
 * 5.466/100.43 in geo.ts — 20.5 km apart, and the second one sat NORTH of Juru
 * (P2, 5.35), i.e. nowhere near Batu Kawan, which skewed every estimated trip
 * distance shown to drivers and on the Performance board.
 *
 * ⚠ The API keeps its own copy of this literal in `api/src/lib/geo.ts` — the
 * two packages deploy from separate Railway root directories and cannot import
 * across the boundary. THEY MUST STAY EQUAL: change one, change the other.
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
  return { latitude: 5.4, longitude: 100.4 };
}

/** The subset of a consignee this module needs — keeps geo.ts free of types.ts. */
export interface PositionedConsignee {
  latitude?: number | null;
  longitude?: number | null;
  zone_code?: string | null;
}

export interface Destination {
  coord: LatLng;
  /**
   * True when `coord` is this consignee's own geocoded building position;
   * false when it is the zone centroid, i.e. an area, not an address.
   */
  precise: boolean;
}

/**
 * Where the driver is actually going.
 *
 * Prefers the consignee's geocoded building coordinate and falls back to the
 * zone centroid. The centroid is one shared point per zone, so before this
 * every consignee in (say) P2 navigated to the same dot in Juru — the driver
 * had to already know the route.
 *
 * **Presence of the coordinates IS the precision gate** — see the note on
 * `Consignee.latitude` in types.ts. The geocode scripts null out anything
 * coarser than a real building, so there is nothing to re-check here; matching
 * on `geocode_match_type` would be wrong, as that column carries two different
 * provider vocabularies. `Number.isFinite` guards against a malformed payload
 * (a null/NaN pair must fall back, never navigate to 0,0 in the Atlantic).
 */
export function consigneeDestination(c?: PositionedConsignee | null): Destination {
  if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude)) {
    return { coord: { latitude: c.latitude as number, longitude: c.longitude as number }, precise: true };
  }
  return { coord: zoneCoord(c?.zone_code), precise: false };
}

// Rough straight-line distance (km) — labelled as approximate in the UI.
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  // PRECISE, not rounded. This function is an api↔mobile twin
  // (api/tests/geoMirror.test.ts), and the two copies used to differ by exactly
  // this Math.round — the same name returning 26 here and 25.923... there.
  //
  // Precision is the correct SHARED semantics, and the api side proves it:
  // lib/earlyTap compares against a 500 METRE radius, which a km-rounded value
  // cannot express at all. Rounding is presentation, so it now happens at the
  // one place that displays a distance (ActiveTripScreen), not inside the rule.
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// A region that frames both origin and destination on the map.
export function regionFor(a: LatLng, b: LatLng) {
  const midLat = (a.latitude + b.latitude) / 2;
  const midLon = (a.longitude + b.longitude) / 2;
  const latDelta = Math.max(Math.abs(a.latitude - b.latitude) * 1.8, 0.15);
  const lonDelta = Math.max(Math.abs(a.longitude - b.longitude) * 1.8, 0.15);
  return { latitude: midLat, longitude: midLon, latitudeDelta: latDelta, longitudeDelta: lonDelta };
}
