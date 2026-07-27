/**
 * Consignee geocoding — Google Geocoding API. The pure query/gate pieces are
 * shared with scripts/geocode-google.ts (which imports from here) so the
 * WRITE-TIME PRECISION GATE can never drift between the batch script and
 * creation-time geocoding:
 *
 *   ROOFTOP / RANGE_INTERPOLATED  → store coordinates (a real position)
 *   anything coarser / failure    → store NULL coords — the zone-centroid
 *                                   fallback, never a bad guess
 *
 * `geocode_match_type` records the verbatim location_type either way, but is
 * NEVER a read gate (it carries three provider vocabularies — Geoapify,
 * Google, driver_fix). Presence of coordinates is the only gate.
 *
 * geocodeNewConsignee() deliberately supersedes the "populated offline,
 * never at request time" note frozen into schema.prisma (owner request,
 * 27 Jul 2026): a new consignee now geocodes once at creation,
 * FIRE-AND-FORGET — a failure or a missing GOOGLE_MAPS_KEY leaves the row
 * exactly as before this feature (null coords, zone fallback). It must
 * never make consignee creation fail or block.
 */
import { prisma } from "./prisma";

const nz = (s: string | null | undefined) => (s ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when address_1 is a "care of" line, i.e. a company, not a street. */
export function isCareOf(address1: string | null | undefined): boolean {
  return /^\s*c\s*\/\s*o\b/i.test(nz(address1));
}

/** The geocoder query for one consignee. address_2 appended ONLY for C/O rows. */
export function buildQuery(c: {
  address_1: string | null;
  address_2: string | null;
  area: string | null;
  state: string | null;
  postal_code: string | null;
}): string {
  const parts = [nz(c.address_1).replace(/,+\s*$/, "")];
  if (isCareOf(c.address_1) && nz(c.address_2)) parts.push(nz(c.address_2).replace(/,+\s*$/, ""));
  parts.push(nz(c.area), nz(c.postal_code), nz(c.state), "Malaysia");
  return parts.filter(Boolean).join(", ");
}

/** location_types that represent a REAL position. Anything else is not a geocode. */
export const USABLE_TYPES = ["ROOFTOP", "RANGE_INTERPOLATED"];
export function isUsable(locationType: string | null | undefined): boolean {
  return USABLE_TYPES.includes(nz(locationType));
}

export interface GeoResult {
  lat: number | null;
  lng: number | null;
  locationType: string;
}

export async function googleGeocode(q: string, key: string, attempts = 6): Promise<GeoResult> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:MY&key=${key}`;
  for (let i = 0; i < attempts; i++) {
    let j: any;
    try {
      j = await (await fetch(url)).json();
    } catch {
      await sleep(1500);
      continue;
    }
    if (j.status === "OK" && j.results?.[0]) {
      const g = j.results[0];
      return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, locationType: g.geometry.location_type };
    }
    if (j.status === "ZERO_RESULTS") return { lat: null, lng: null, locationType: "ZERO_RESULTS" };
    // OVER_QUERY_LIMIT / UNKNOWN_ERROR / (freshly-enabled) REQUEST_DENIED → back off and retry
    if (["OVER_QUERY_LIMIT", "UNKNOWN_ERROR", "REQUEST_DENIED"].includes(j.status)) {
      await sleep(2000 * (i + 1));
      continue;
    }
    return { lat: null, lng: null, locationType: j.status || "ERROR" };
  }
  return { lat: null, lng: null, locationType: "RETRY_EXHAUSTED" };
}

/**
 * THE write-time precision gate, as pure data: what a geocode result stores.
 * Coordinates only for usable types; the verbatim location_type always.
 */
export function geocodeStoreFields(g: GeoResult): {
  latitude: number | null;
  longitude: number | null;
  geocode_match_type: string;
} {
  const keep = isUsable(g.locationType) && g.lat != null && g.lng != null;
  return {
    latitude: keep ? g.lat : null,
    longitude: keep ? g.lng : null,
    geocode_match_type: g.locationType,
  };
}

/**
 * Creation-time geocode, fire-and-forget (call with `void`, never await on
 * the request path). No key → no-op. Fill-only write: never overwrites
 * coordinates that appeared meanwhile (admin fix, batch run, self-heal).
 */
export async function geocodeNewConsignee(c: {
  id: string;
  address_1: string | null;
  address_2: string | null;
  area: string | null;
  state: string | null;
  postal_code: string | null;
}): Promise<void> {
  const key = process.env.GOOGLE_MAPS_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
  if (!key) return;
  try {
    // 2 attempts (not the batch script's 6): this runs per creation and must
    // stay bounded; a miss is caught by the next manual batch run anyway.
    const g = await googleGeocode(buildQuery(c), key, 2);
    await prisma.consignee.updateMany({
      where: { id: c.id, latitude: null, longitude: null },
      data: geocodeStoreFields(g),
    });
  } catch (err) {
    console.warn(`geocodeNewConsignee(${c.id}): ${(err as Error).message}`);
  }
}
