// Approximate zone centroids for the fleet map. There is no live GPS yet
// (Development Brief Section 12) — consignees are stored by zone, not lat/long.
// Truck markers are placed at their primary zone's centroid with a small
// deterministic offset so multiple trucks in one zone don't perfectly overlap.
import { colors } from "@/theme";

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
  { code: "JH", name: "Johor", lat: 1.4927, lng: 103.7414, color: "#0d9488" },
  { code: "SL", name: "Selangor", lat: 3.0738, lng: 101.5183, color: "#7c3aed" },
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
