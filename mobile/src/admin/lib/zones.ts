// Approximate zone centroids for the fleet map — HAND-PICKED points, NOT real
// zone boundaries (consignees are stored by zone_code, with no lat/long, so no
// true catchment can be derived). They exist to label the map and to place a
// truck that has no GPS fix: `truckPosition` puts it on its primary zone's
// centroid with a small deterministic offset so trucks in one zone don't
// perfectly overlap. Those placeholder markers are GHOSTED on the map (grey,
// faded, "~" prefix) so they can't be mistaken for a real position — real fixes
// come from GET /fleet/live (driver-phone GPS, active trips only).
import { colors } from "../theme";

export interface ZoneInfo {
  code: string;
  name: string;
  lat: number;
  lng: number;
  color: string;
}

export const PLANT_ORIGIN = { lat: 5.2837, lng: 100.4577, label: "UWC Batu Kawan" };

export const ZONES: ZoneInfo[] = [
  { code: "P1", name: "Penang Island", lat: 5.4145, lng: 100.3294, color: colors.blue },
  { code: "P2", name: "Juru & Perai", lat: 5.3318, lng: 100.4007, color: colors.green },
  { code: "P3", name: "Tasek Gelugor", lat: 5.4669, lng: 100.4884, color: colors.orange },
  { code: "K1", name: "Kulim", lat: 5.3653, lng: 100.5618, color: "#9333ea" },
  { code: "K2", name: "Sg. Petani / Kuala Ketil", lat: 5.6497, lng: 100.4878, color: "#0891b2" },
  { code: "A1", name: "Taiping", lat: 4.8501, lng: 100.738, color: colors.amber },
  { code: "A2", name: "Ipoh", lat: 4.5975, lng: 101.0901, color: colors.red },
  // Long-haul zone (8 points, bookable — spec §10). KL was missing here
  // entirely, which also left the trip board's zone filter unable to find
  // long-haul bookings (audit 2026-07-05 #11). (Johor/Selangor were placeholder
  // zones, removed 18 Jul 2026 — Mr. Teh confirmed they won't be used.)
  { code: "KL", name: "Kuala Lumpur", lat: 3.139, lng: 101.6869, color: "#be185d" },
];

export const ZONE_BY_CODE: Record<string, ZoneInfo> = Object.fromEntries(
  ZONES.map((z) => [z.code, z])
);

// Map center / zoom that frames the whole operating region (Penang → Ipoh).
export const MAP_CENTER: [number, number] = [5.1, 100.55];
export const MAP_ZOOM = 8;

// Deterministic small offset so trucks in the same zone fan out slightly.
function jitter(seed: string): { dlat: number; dlng: number } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  const angle = (h / 997) * Math.PI * 2;
  const r = 0.035;
  return { dlat: Math.sin(angle) * r, dlng: Math.cos(angle) * r };
}

export function truckPosition(plate: string, zones: string[]): [number, number] {
  const primary = zones.find((z) => ZONE_BY_CODE[z]) ?? "P2";
  const z = ZONE_BY_CODE[primary];
  const { dlat, dlng } = jitter(plate);
  return [z.lat + dlat, z.lng + dlng];
}
