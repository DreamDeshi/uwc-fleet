import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { PLANT_ORIGIN, ZONE_COORDS } from "./geo";
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
