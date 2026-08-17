/**
 * Consignee geocoding — Google Geocoding API. The pure query/gate pieces are
 * shared with scripts/geocode-google.ts (which imports from here) so the
 * WRITE-TIME PRECISION GATE can never drift between the batch script and
 * creation-time geocoding:
 *
 *   any answer with a POSITION   → store coordinates (building, road or area)
 *   a non-answer / failure       → store NULL coords — the zone-centroid
 *                                  fallback, never a bad guess
 *
 * `geocode_match_type` records the verbatim location_type either way. It is
 * read in exactly ONE place, `lib/geocodePrecision.ts`, which maps all four
 * provider vocabularies; read that file before matching on this column
 * anywhere else, because ad-hoc matching on one vocabulary is a defect this
 * repo has already had.
 *
 * geocodeNewConsignee() deliberately supersedes the "populated offline,
 * never at request time" note frozen into schema.prisma (owner request,
 * 27 Jul 2026): a new consignee now geocodes once at creation,
 * FIRE-AND-FORGET — a failure or a missing GOOGLE_MAPS_KEY leaves the row
 * exactly as before this feature (null coords, zone fallback). It must
 * never make consignee creation fail or block.
 */
import { prisma } from "./prisma";
import { geocodePrecision } from "./geocodePrecision";

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

/**
 * location_types that represent a BUILDING position — the grade that may be
 * used to judge where a driver was (`isJudgeablePin`).
 *
 * ⚠ THIS IS NO LONGER THE STORE GATE. It was, and that is why 349 production
 * consignees have no coordinate at all: everything coarser was discarded, so
 * they navigate to a zone centroid up to 27 km away. `isStorable` below is now
 * what decides whether coordinates are written. Keep this export — the batch
 * script and the precision model both mean BUILDING by it.
 */
export const USABLE_TYPES = ["ROOFTOP", "RANGE_INTERPOLATED"];
export function isUsable(locationType: string | null | undefined): boolean {
  return USABLE_TYPES.includes(nz(locationType));
}

/**
 * THE STORE GATE: is this answer a POSITION at all?
 *
 * Anything the geocoder could actually place — building, road or area — is
 * stored, because every one of them is nearer than the zone centroid that is
 * the alternative. What is NOT stored is a non-answer: ZERO_RESULTS, an error,
 * a retry exhaustion. Those carry no position, and inventing one would be the
 * "bad guess" the old gate rightly refused.
 *
 * The grade travels with the row in `geocode_match_type` and is read through
 * `geocodePrecision`, so a coarse pin can be drawn and labelled honestly
 * without being mistaken for a building.
 */
export function isStorable(locationType: string | null | undefined): boolean {
  return geocodePrecision(nz(locationType)) !== "unknown";
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
 * THE write-time gate, as pure data: what a geocode result stores.
 *
 * Coordinates for any answer that carries a POSITION — building, road or area
 * — and the verbatim location_type always, which is what lets a reader tell
 * those three apart afterwards. A non-answer (ZERO_RESULTS, an error) stores
 * NULL coordinates and falls back to the zone centroid, exactly as before.
 *
 * ⚠ This used to keep BUILDING grades only. Widening it is the whole point of
 * the road-level work: it is why `earlyTap` now asks `isJudgeablePin` instead
 * of trusting null-ness, and the two changes must not be separated.
 */
export function geocodeStoreFields(g: GeoResult): {
  latitude: number | null;
  longitude: number | null;
  geocode_match_type: string;
} {
  const keep = isStorable(g.locationType) && g.lat != null && g.lng != null;
  return {
    latitude: keep ? g.lat : null,
    longitude: keep ? g.lng : null,
    geocode_match_type: g.locationType,
  };
}

/**
 * Record why a lookup produced no position, WITHOUT inventing one.
 *
 * Fill-only (`latitude: null, longitude: null` in the where) so it can never
 * overwrite a coordinate that arrived meanwhile from an admin fix, a batch run
 * or the self-heal. Swallows its own errors: this is called from a
 * fire-and-forget path and from a catch block, and it must not be able to
 * escalate a geocode problem into a failed consignee creation.
 */
async function recordVerdict(id: string, verdict: string): Promise<void> {
  try {
    await prisma.consignee.updateMany({
      where: { id, latitude: null, longitude: null },
      data: { geocode_match_type: verdict },
    });
  } catch {
    /* best effort — the caller is already handling a failure */
  }
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
  if (!key) {
    // ⚠ THIS USED TO BE A BARE `return`, AND THAT WAS THE WHOLE DEFECT.
    //
    // With no key, every new consignee was left exactly as if nothing had been
    // attempted: null coords, null match_type. `/consignees/coverage` reads a
    // null match_type as NEVER GEOCODED and the admin screen then says "a
    // geocode run would fill it" — advice that is precisely wrong, because a
    // run with no key fills nothing. The count grows with every consignee
    // added, the advice stays confidently wrong, and NOTHING anywhere says the
    // lookup is not running.
    //
    // So record the verdict. It costs one fill-only write and turns an
    // invisible misconfiguration into a number an admin can see.
    await recordVerdict(c.id, "NO_API_KEY");
    return;
  }
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
    // Same reasoning as the no-key path: a thrown error wrote nothing, so a
    // broken lookup was indistinguishable from one that never ran. This write
    // is itself best-effort — if the database is what failed, there is nothing
    // further to do and this must still never throw into a creation request.
    await recordVerdict(c.id, "ERROR");
  }
}
