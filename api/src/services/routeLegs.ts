/**
 * Road geometry for a trip, assembled from the PRE-COMPUTED RouteLeg table.
 *
 * This replaced a live Google Directions call (2026-07-20). There is no runtime
 * routing provider: no API key, no account, no quota, no third-party terms. The
 * legs were generated once against a locally-run OpenRouteService — see
 * scripts/gen-route-legs.ts and the RouteLeg model in schema.prisma.
 *
 * It works because trip destinations are ZONE CENTROIDS, not real addresses
 * (Consignee stores zone_code only), so every path the system can ask for is a
 * concatenation of legs over {PLANT} ∪ {the 8 zone centroids}. Geocoding real
 * consignee addresses would break that assumption — see the model comment.
 *
 * Everything degrades to the straight line rather than failing: a missing leg,
 * an unknown zone, or a STALE leg (one generated for coordinates that have since
 * moved) all fall back, so the map always renders something.
 */
import { prisma } from "../lib/prisma";
import {
  PLANT_ORIGIN,
  ZONE_COORDS,
  decodePolyline,
  straightRoute,
  type LatLng,
  type RouteResult,
} from "../lib/geo";

export const PLANT_KEY = "PLANT";

/**
 * Tolerance when checking a stored leg against the live coordinates. The
 * columns are DECIMAL(10,7) — 1e-7 degrees, roughly a centimetre — so anything
 * above rounding noise means the constant genuinely moved and the geometry no
 * longer starts/ends where we think it does.
 */
const COORD_EPSILON = 1e-6;

export function pointForKey(key: string): LatLng | null {
  if (key === PLANT_KEY) return PLANT_ORIGIN;
  return ZONE_COORDS[key] ?? null;
}

/**
 * Turn a trip's stop zone codes into the leg key path, PLANT first. Consecutive
 * duplicates collapse (several stops in one zone are one destination), and an
 * unrecognised zone code aborts to null — we will not guess which leg to use.
 */
export function keyPathFor(zoneCodes: (string | null | undefined)[]): string[] | null {
  const path: string[] = [PLANT_KEY];
  for (const code of zoneCodes) {
    if (!code || !ZONE_COORDS[code]) return null;
    if (path[path.length - 1] !== code) path.push(code);
  }
  return path.length >= 2 ? path : null;
}

/** True when a stored leg still matches the coordinates it was generated for. */
export function legIsFresh(
  leg: { from_lat: unknown; from_lng: unknown; to_lat: unknown; to_lng: unknown },
  from: LatLng,
  to: LatLng
): boolean {
  const near = (stored: unknown, live: number) => Math.abs(Number(stored) - live) <= COORD_EPSILON;
  return (
    near(leg.from_lat, from.latitude) &&
    near(leg.from_lng, from.longitude) &&
    near(leg.to_lat, to.latitude) &&
    near(leg.to_lng, to.longitude)
  );
}

/**
 * Join decoded legs into one polyline, dropping each leg's first point because
 * it repeats the previous leg's last point (they meet at the same centroid).
 * Pure, so the joining logic is unit-testable without a database.
 */
export function joinLegPolylines(legs: LatLng[][]): LatLng[] {
  const out: LatLng[] = [];
  for (const leg of legs) {
    out.push(...(out.length === 0 ? leg : leg.slice(1)));
  }
  return out;
}

/**
 * The route for a trip whose stops are in `zoneCodes`, in order.
 * Always resolves — never throws — falling back to the straight line.
 */
export async function getRoute(zoneCodes: (string | null | undefined)[]): Promise<RouteResult> {
  const path = keyPathFor(zoneCodes);
  if (!path) {
    // Unknown/absent zone: fall back through the generic centroid so the caller
    // still gets a two-point line from the plant.
    return straightRoute([PLANT_ORIGIN, ZONE_COORDS.P2]);
  }

  const points = path.map((k) => pointForKey(k)!);
  const straight = straightRoute(points);

  const wanted = path.slice(0, -1).map((from, i) => ({ from_key: from, to_key: path[i + 1] }));

  let rows;
  try {
    rows = await prisma.routeLeg.findMany({ where: { OR: wanted } });
  } catch {
    return straight; // table missing (migration not applied yet) or DB hiccup
  }

  const byKey = new Map(rows.map((r) => [`${r.from_key}>${r.to_key}`, r]));
  const decoded: LatLng[][] = [];
  let distance = 0;
  let duration = 0;

  for (let i = 0; i < wanted.length; i++) {
    const leg = byKey.get(`${wanted[i].from_key}>${wanted[i].to_key}`);
    if (!leg) return straight; // not generated for this pair
    if (!legIsFresh(leg, points[i], points[i + 1])) return straight; // constants moved
    decoded.push(decodePolyline(leg.polyline));
    distance += leg.distance_m;
    duration += leg.duration_s;
  }

  return {
    polyline: joinLegPolylines(decoded),
    distance_m: distance,
    duration_s: duration,
    source: "precomputed",
  };
}
