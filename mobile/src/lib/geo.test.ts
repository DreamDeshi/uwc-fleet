import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { PLANT_ORIGIN, ZONE_COORDS, consigneeDestination, zoneCoord } from "./geo";
import { PLANT_ORIGIN as ADMIN_PLANT } from "../admin/lib/zones";

// The plant coordinate is geocoded from the workbook's documented address
// (PMT 744, Jalan Cassia Selatan 5/1, Batu Kawan). It was wrong in TWO places
// at once until 2026-07-20, so these tests exist to stop it drifting again.
describe("PLANT_ORIGIN", () => {
  it("is the geocoded Batu Kawan address, not one of the old guesses", () => {
    expect(PLANT_ORIGIN.latitude).toBeCloseTo(5.216238509805299, 12);
    expect(PLANT_ORIGIN.longitude).toBeCloseTo(100.4445982584094, 12);
    // The two retired guesses — neither may come back.
    expect(PLANT_ORIGIN.latitude).not.toBeCloseTo(5.2837, 4);
    expect(PLANT_ORIGIN.latitude).not.toBeCloseTo(5.466, 3);
  });

  it("is SOUTH of the Juru/Perai (P2) centroid — Batu Kawan is south of Juru", () => {
    // The sanity check that would have caught the 5.466 guess: that value sat
    // north of P2, between Juru and Tasek Gelugor.
    expect(PLANT_ORIGIN.latitude).toBeLessThan(ZONE_COORDS.P2.latitude);
  });

  it("is the SAME object the admin fleet map draws its marker from", () => {
    // admin/lib/zones.ts must adapt this constant, never redeclare one.
    expect(ADMIN_PLANT.lat).toBe(PLANT_ORIGIN.latitude);
    expect(ADMIN_PLANT.lng).toBe(PLANT_ORIGIN.longitude);
  });

  it("matches the API's copy in api/src/lib/geo.ts", () => {
    // The API deploys from its own Railway root directory and cannot import
    // across the package boundary, so it holds a duplicate literal. This test
    // is the ONLY thing keeping the two in step — read it off disk and compare.
    const apiGeo = fs.readFileSync(path.resolve("../api/src/lib/geo.ts"), "utf8");
    const match = apiGeo.match(
      /export const PLANT_ORIGIN: LatLng = \{ latitude: ([-\d.]+), longitude: ([-\d.]+) \}/
    );
    expect(match, "could not find PLANT_ORIGIN in api/src/lib/geo.ts").not.toBeNull();
    expect(Number(match![1])).toBe(PLANT_ORIGIN.latitude);
    expect(Number(match![2])).toBe(PLANT_ORIGIN.longitude);
  });
});

// The driver's Navigate target. Before this, every consignee in a zone routed to
// one shared centroid; these pin the precedence and — more importantly — that a
// missing or malformed geocode falls back rather than navigating somewhere wrong.
describe("consigneeDestination", () => {
  // A real geocoded row: Juru (P2) consignee whose building is NOT the centroid.
  const geocoded = { latitude: 5.3021, longitude: 100.4408, zone_code: "P2" };

  it("uses the consignee's own building coordinate when it has one", () => {
    const d = consigneeDestination(geocoded);
    expect(d.coord).toEqual({ latitude: 5.3021, longitude: 100.4408 });
    expect(d.precise).toBe(true);
    // The whole point: it is NOT the zone centroid it would have used before.
    expect(d.coord).not.toEqual(ZONE_COORDS.P2);
  });

  it("falls back to the zone centroid when the row was never geocoded", () => {
    const d = consigneeDestination({ latitude: null, longitude: null, zone_code: "K2" });
    expect(d.coord).toEqual(ZONE_COORDS.K2);
    expect(d.precise).toBe(false);
  });

  it("falls back when the precision gate demoted the row (coords nulled at write time)", () => {
    // geocode-google.ts stores NULL coords for anything coarser than a building
    // and for duplicate pins, keeping geocode_match_type for provenance. The
    // reader must not try to interpret that column — absence of coords is the gate.
    const demoted = { latitude: null, longitude: null, zone_code: "P1", geocode_match_type: "APPROXIMATE" };
    expect(consigneeDestination(demoted).coord).toEqual(ZONE_COORDS.P1);
  });

  it("falls back on a HALF-populated pair rather than navigating to a bogus point", () => {
    expect(consigneeDestination({ latitude: 5.3021, longitude: null, zone_code: "P2" }).precise).toBe(false);
    expect(consigneeDestination({ latitude: null, longitude: 100.4408, zone_code: "P2" }).precise).toBe(false);
  });

  it("falls back on NaN — a malformed payload must never become a destination", () => {
    const d = consigneeDestination({ latitude: NaN, longitude: NaN, zone_code: "A2" });
    expect(d.precise).toBe(false);
    expect(d.coord).toEqual(ZONE_COORDS.A2);
  });

  it("falls back to the default point for a missing consignee or unknown zone", () => {
    expect(consigneeDestination(null).coord).toEqual(zoneCoord(null));
    expect(consigneeDestination({ zone_code: "ZZ" }).coord).toEqual(zoneCoord("ZZ"));
  });
});
