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

/** The zone a fix-less truck is drawn in: its first RECOGNISED priority zone. */
export function primaryZone(zones: string[]): string {
  return zones.find((z) => ZONE_BY_CODE[z]) ?? "P2";
}

// Radius (degrees, ~5km) of the ring co-zone ghosts are spread around. Big
// enough that their labels clear each other at the zooms the fleet map is
// actually read at; small enough that a ghost still reads as "in this zone".
const GHOST_RING = 0.045;

/**
 * Where to draw every truck that has NO GPS fix.
 *
 * These are placeholders on a zone centroid, so several trucks in one zone
 * would otherwise stack on the exact same point. The old approach offset each
 * plate by a HASH of its own characters — independent of the other trucks, so
 * two plates whose hashes landed near each other still overlapped. Three of the
 * seeded trucks share P1 and did exactly that, piling up unreadably over George
 * Town.
 *
 * Instead, spread them EVENLY: group by zone, then place each truck at its own
 * angle on a ring around the centroid, so N trucks are always 360/N apart and
 * can never collide. Sorted by plate so the layout is stable between renders
 * (a truck must not jump when an unrelated truck gains or loses a fix).
 * A truck alone in its zone sits exactly on the centroid, no offset.
 */
export function ghostPositions(
  trucks: { plate: string; priority_zones: string[] }[]
): Record<string, [number, number]> {
  const byZone: Record<string, string[]> = {};
  for (const t of trucks) {
    const zone = primaryZone(t.priority_zones);
    (byZone[zone] ??= []).push(t.plate);
  }

  const out: Record<string, [number, number]> = {};
  for (const [zone, plates] of Object.entries(byZone)) {
    const z = ZONE_BY_CODE[zone];
    plates.sort();
    for (let i = 0; i < plates.length; i++) {
      if (plates.length === 1) {
        out[plates[i]] = [z.lat, z.lng];
        continue;
      }
      const angle = (i / plates.length) * Math.PI * 2;
      out[plates[i]] = [z.lat + Math.sin(angle) * GHOST_RING, z.lng + Math.cos(angle) * GHOST_RING];
    }
  }
  return out;
}
