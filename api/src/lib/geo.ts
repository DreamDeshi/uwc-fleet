// Server-side geography helpers for Phase 5 (GPS + live location).
//
// The schema stores consignees by zone, not lat/long, so until we geocode real
// addresses the destination of a trip is approximated by its zone centroid.
// These coordinates mirror the mobile app's lib/geo.ts so both ends agree.

export interface LatLng {
  latitude: number;
  longitude: number;
}

// UWC Industrial, Batu Kawan, Penang — origin of most trips.
export const PLANT_ORIGIN: LatLng = { latitude: 5.466, longitude: 100.43 };

export const ZONE_COORDS: Record<string, LatLng> = {
  P1: { latitude: 5.4145, longitude: 100.3292 }, // Penang Island
  P2: { latitude: 5.35, longitude: 100.4 }, // Juru & Perai
  P3: { latitude: 5.5333, longitude: 100.4833 }, // Tasek Gelugor
  K1: { latitude: 5.365, longitude: 100.561 }, // Kulim
  K2: { latitude: 5.647, longitude: 100.487 }, // Sungai Petani / Kuala Ketil
  A1: { latitude: 4.85, longitude: 100.7333 }, // Taiping
  A2: { latitude: 4.5975, longitude: 101.0901 }, // Ipoh
};

export function zoneCoord(zoneCode?: string | null): LatLng {
  if (zoneCode && ZONE_COORDS[zoneCode]) return ZONE_COORDS[zoneCode];
  return { latitude: 5.4, longitude: 100.4 }; // fallback: somewhere over Penang mainland
}

// Great-circle distance in km. Used to estimate trip distance from zone
// centroids when we don't have a Google road distance (no API key / fallback).
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
  source: "google" | "straight"; // "straight" = fallback when Google is unavailable
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

// Ask Google Directions for the real road path origin → (waypoints) → destination.
// Falls back to a straight line if there's no API key or the request fails, so
// the app keeps working without Google configured (e.g. local dev).
export async function getRoute(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[] = []
): Promise<RouteResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const straight: RouteResult = {
    polyline: [origin, ...waypoints, destination],
    distance_m: null,
    duration_s: null,
    source: "straight",
  };
  if (!key) return straight;

  const fmt = (p: LatLng) => `${p.latitude},${p.longitude}`;
  const params = new URLSearchParams({
    origin: fmt(origin),
    destination: fmt(destination),
    mode: "driving",
    key,
  });
  if (waypoints.length > 0) {
    params.set("waypoints", waypoints.map(fmt).join("|"));
  }

  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const data = (await res.json()) as {
      status: string;
      routes: {
        overview_polyline: { points: string };
        legs: { distance: { value: number }; duration: { value: number } }[];
      }[];
    };

    const route = data.routes?.[0];
    if (data.status !== "OK" || !route) return straight;

    const distance_m = route.legs.reduce((sum, l) => sum + l.distance.value, 0);
    const duration_s = route.legs.reduce((sum, l) => sum + l.duration.value, 0);
    return {
      polyline: decodePolyline(route.overview_polyline.points),
      distance_m,
      duration_s,
      source: "google",
    };
  } catch {
    return straight; // network/quota error — degrade gracefully
  }
}
