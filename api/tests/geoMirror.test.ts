import { describe, it, expect } from "vitest";
import * as apiGeo from "../src/lib/geo";
import * as mobileGeo from "../../mobile/src/lib/geo";

/**
 * DRIFT GUARD: api/src/lib/geo.ts and mobile/src/lib/geo.ts are hand-maintained
 * twins, and the thing they share is a MAP OF PHYSICAL PLACES.
 *
 * What each side does with it is different, which is exactly why nothing has
 * been comparing them:
 *
 *   api     estimateTripDistanceKm — the km on the driver's Earnings summary
 *           and the distance behind the sustainability KPIs
 *   mobile  consigneeDestination — where the driver's NAVIGATE button opens
 *           when a consignee has no geocode (DG-D2's zone-centroid fallback)
 *
 * So a one-sided edit to a zone centroid sends the driver to one point while
 * the server bills the distance to another, and neither module's own tests
 * notice: each checks its own copy against its own numbers.
 *
 * Only the SHARED surface is compared. `estimateTripDistanceKm`,
 * `straightRoute` and `decodePolyline` are api-only; `consigneeDestination` and
 * `regionFor` are mobile-only. Those are legitimate platform differences, not
 * drift. Behaviour is compared, never source text — comments and ordering may
 * differ freely.
 */

const api = apiGeo as unknown as Record<string, unknown>;
const mobile = mobileGeo as unknown as Record<string, unknown>;

const SHARED_EXPORTS = ["PLANT_ORIGIN", "ZONE_COORDS", "zoneCoord", "haversineKm"] as const;

/** Every zone the spec defines, plus the shapes a caller can actually pass. */
const ZONE_INPUTS = [
  "P1", "P2", "P3", "K1", "K2", "A1", "A2", "KL",
  "JH", "SL", // retired zones — both sides must agree they are gone
  "p1", "k2", " A2", "A2 ", "", "ZZ", "unknown",
  null, undefined,
] as const;

/** Real coordinate pairs, plus the degenerate ones a bad geocode produces. */
const COORD_PAIRS: [{ latitude: number; longitude: number }, { latitude: number; longitude: number }][] = [
  [{ latitude: 5.4164, longitude: 100.3327 }, { latitude: 5.3654, longitude: 100.5612 }], // Penang → Kulim
  [{ latitude: 5.4164, longitude: 100.3327 }, { latitude: 4.5975, longitude: 101.0901 }], // → Ipoh
  [{ latitude: 3.139, longitude: 101.6869 }, { latitude: 5.4164, longitude: 100.3327 }], // KL → Penang
  [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }], // identical: must be 0, not NaN
  [{ latitude: 5.4, longitude: 100.4 }, { latitude: 5.4, longitude: 100.4 }],
  [{ latitude: -5, longitude: -100 }, { latitude: 5, longitude: 100 }], // antipodal-ish
];

describe("geo.ts api↔mobile drift guard", () => {
  it("both modules export every shared runtime value", () => {
    for (const name of SHARED_EXPORTS) {
      expect(api[name], `api.${name} missing`).toBeDefined();
      expect(mobile[name], `mobile.${name} missing`).toBeDefined();
    }
  });

  it("PLANT_ORIGIN is the same physical place", () => {
    // The origin every distance is measured from. A silent edit to one copy
    // re-bases every km figure on that side only.
    expect(mobile.PLANT_ORIGIN).toEqual(api.PLANT_ORIGIN);
  });

  it("ZONE_COORDS is identical — same zones, same centroids", () => {
    const a = api.ZONE_COORDS as Record<string, unknown>;
    const m = mobile.ZONE_COORDS as Record<string, unknown>;
    // Compared as a whole rather than key-by-key so an EXTRA zone on one side
    // fails too, not just a changed one.
    expect(m).toEqual(a);
    expect(Object.keys(m).sort()).toEqual(Object.keys(a).sort());
  });

  it("zoneCoord agrees on every zone, including junk and the retired ones", () => {
    const aFn = api.zoneCoord as (z: unknown) => unknown;
    const mFn = mobile.zoneCoord as (z: unknown) => unknown;
    for (const zone of ZONE_INPUTS) {
      expect(mFn(zone), `zoneCoord(${JSON.stringify(zone)})`).toEqual(aFn(zone));
    }
  });

  it("haversineKm agrees, including the identical-point case", () => {
    const aFn = api.haversineKm as (a: unknown, b: unknown) => number;
    const mFn = mobile.haversineKm as (a: unknown, b: unknown) => number;
    for (const [from, to] of COORD_PAIRS) {
      const expected = aFn(from, to);
      expect(mFn(from, to), `haversineKm(${JSON.stringify(from)}, ${JSON.stringify(to)})`).toBeCloseTo(
        expected,
        9
      );
      expect(Number.isFinite(expected), "distance must be finite").toBe(true);
    }
  });
});
