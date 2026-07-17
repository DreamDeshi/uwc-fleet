// The schema stores consignees by zone/area, not lat-long, so the map can only
// be approximate. We centre on the UWC plant (Batu Kawan) and plot a marker at
// the rough centroid of the destination zone. This is illustrative — clearly
// not turn-by-turn (no GPS this phase). TODO: geocode consignee addresses.

export interface LatLng {
  latitude: number;
  longitude: number;
}

// UWC Industrial, Batu Kawan, Penang (origin of most trips).
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
  return { latitude: 5.4, longitude: 100.4 };
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
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
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
