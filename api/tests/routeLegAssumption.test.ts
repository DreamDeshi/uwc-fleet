import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyPathFor, pointForKey, PLANT_KEY } from "../src/services/routeLegs";
import { ZONE_COORDS } from "../src/lib/geo";

/**
 * THE CONDITION THAT A COMMENT NAMED AND NOTHING WATCHED.
 *
 * `services/routeLegs.ts` shipped with a correct warning in its header:
 *
 *     "It works because trip destinations are ZONE CENTROIDS, not real
 *      addresses (Consignee stores zone_code only) … Geocoding real consignee
 *      addresses would break that assumption."
 *
 * Consignee addresses were then geocoded. 1,006 of 1,564 carried a coordinate
 * at the last production read. The warning was RIGHT, the condition came TRUE,
 * and nothing noticed for weeks, because a sentence cannot fail.
 *
 * ⚠ A comment that predicts a break cannot detect the break. If a comment names
 * a condition that would invalidate the design, that condition wants a TEST.
 * This is that test.
 *
 * It does not try to stop the geometry being coarse — that is by design, and
 * fixing it costs a routing provider. It pins the CONSEQUENCES that were
 * decided once the assumption broke, so that reversing one is a deliberate act
 * that turns something red.
 */
describe("RouteLeg is zone-keyed, and the app must keep saying so", () => {
  it("every routable node is the plant or a zone centroid — never an address", () => {
    // The assumption itself, stated as an assertion instead of a sentence.
    expect(pointForKey(PLANT_KEY)).not.toBeNull();
    const zones = Object.keys(ZONE_COORDS);
    expect(zones.length, "positive control: the zone table must not be empty").toBeGreaterThan(5);
    for (const z of zones) expect(pointForKey(z), `zone ${z}`).not.toBeNull();
    // Anything that is not one of those nine nodes is unroutable, by design.
    expect(pointForKey("some-consignee-id")).toBeNull();
    expect(pointForKey("5.6494,100.4881")).toBeNull();
  });

  it("a path always starts at the PLANT — the geometry is plant-anchored", () => {
    // This is WHY the active-trip map cannot use it: there is no way to ask for
    // a path that begins where the driver currently is.
    expect(keyPathFor(["K2"])![0]).toBe(PLANT_KEY);
    expect(keyPathFor(["P2", "K1"])![0]).toBe(PLANT_KEY);
    // No key exists for a live position, so no such path can be requested.
    expect(keyPathFor(["DRIVER"])).toBeNull();
  });
});

describe("the decisions taken once the assumption broke", () => {
  const read = (rel: string) => {
    const raw = readFileSync(join(__dirname, "..", "..", "mobile", "src", "components", rel), "utf8");
    // Strip comments: these files EXPLAIN the removed line at length, and a
    // source guard that reads comments is satisfied by the explanation.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  for (const file of ["ActiveTripMap.web.tsx", "ActiveTripMap.tsx"]) {
    it(`${file} draws NO route line`, () => {
      /**
       * Owner ruling, 18 Aug 2026. Plant-anchored geometry is wrong at BOTH
       * ends once the driver is moving: it starts at a warehouse he left an
       * hour ago and ends at a zone centroid he is not going to.
       *
       * If this goes red, someone has put the line back. That is only correct
       * if routing now starts from the driver's live position — which needs a
       * runtime routing provider, deliberately removed on 2026-07-20.
       */
      const src = read(file);
      expect(src.length, `${file} moved or was renamed`).toBeGreaterThan(500);
      expect(src, "the map itself must still be here").toContain("Marker");
      expect(src, "a route line on the active-trip map is wrong at both ends").not.toContain(
        "Polyline"
      );
    });
  }

  it("the PRE-TRIP map keeps the line, because there he really is at the plant", () => {
    // The other half of the ruling. Losing this silently would be the same
    // failure in reverse: the shape of the run is genuinely useful before
    // departure, and it is the only place the geometry is honest.
    const src = read("LiveTripMap.web.tsx");
    expect(src).toContain("Polyline");
    expect(src, "only REAL geometry — never a straight-line stand-in").toContain(
      "route?.polyline?.length"
    );
  });
});
