// Approximate zone centroids for the fleet map — HAND-PICKED points, NOT real
// zone boundaries (consignees are stored by zone_code, with no lat/long, so no
// true catchment can be derived). They exist to label the map and to place a
// truck that has no GPS fix: `truckPosition` puts it on its primary zone's
// centroid with a small deterministic offset so trucks in one zone don't
// perfectly overlap. Those placeholder markers are GHOSTED on the map (grey,
// faded, "~" prefix) so they can't be mistaken for a real position — real fixes
// come from GET /fleet/live (driver-phone GPS, active trips only).
import { colors } from "../theme";
import { PLANT_ORIGIN as PLANT } from "../../lib/geo";

export interface ZoneInfo {
  code: string;
  name: string;
  lat: number;
  lng: number;
  color: string;
}

// The fleet map's plant marker. NOT its own coordinate — a {lat,lng}-shaped
// view of the single PLANT_ORIGIN in lib/geo.ts (see the citation there). The
// map components want .lat/.lng; the rest of the app uses .latitude/.longitude.
export const PLANT_ORIGIN = {
  lat: PLANT.latitude,
  lng: PLANT.longitude,
  label: "UWC Batu Kawan",
};

export const ZONES: ZoneInfo[] = [
  { code: "P1", name: "Penang Island", lat: 5.4145, lng: 100.3294, color: colors.blue },
  { code: "P2", name: "Juru & Perai & Batu Kawan", lat: 5.3318, lng: 100.4007, color: colors.green },
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

// Default map view. Centred on the WORKING CORRIDOR — Penang Island,
// Butterworth, Juru, Batu Kawan (the plant) and Kulim — rather than on the
// midpoint of every zone we serve.
//
// ⚠ THIS IS ONLY THE FALLBACK. Both map builds now FIT THE VIEW TO THE LIVE
// TRUCKS (map.web.tsx's FitToFleet, map.tsx's fitToCoordinates), always
// including the plant — so on any day with a truck out, this centre and zoom
// are never used. They frame the depot when NOTHING is live, which is the only
// time there is nothing better to aim at.
//
// Zoom 8 used to be the permanent view and made Penang a smudge in order to
// keep Ipoh on screen (owner, 9 Aug 2026: "need to zoom in to penang more").
// Fitting to the fleet removes that dilemma rather than picking a side: an
// ordinary day opens tight on the northern corridor; the day a truck runs to
// Ipoh, the frame opens to include it.
export const MAP_CENTER: [number, number] = [5.35, 100.48];
export const MAP_ZOOM = 10;

/** The zone a fix-less truck is drawn in: its first RECOGNISED priority zone. */
export function primaryZone(zones: string[]): string {
  return zones.find((z) => ZONE_BY_CODE[z]) ?? "P2";
}
