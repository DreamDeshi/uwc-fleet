import { describe, it, expect } from "vitest";
import { keyPathFor, legIsFresh, joinLegPolylines, pointForKey, PLANT_KEY } from "../src/services/routeLegs";
import { PLANT_ORIGIN, ZONE_COORDS } from "../src/lib/geo";

// The pre-computed route table only works while destinations are zone
// centroids. These pin the pure parts: which legs a trip needs, whether a
// stored leg is still valid for today's coordinates, and how legs join.
describe("keyPathFor", () => {
  it("prefixes PLANT and keeps stop order", () => {
    expect(keyPathFor(["P1", "K1"])).toEqual([PLANT_KEY, "P1", "K1"]);
  });

  it("collapses consecutive stops in the same zone", () => {
    expect(keyPathFor(["P2", "P2", "P2"])).toEqual([PLANT_KEY, "P2"]);
    expect(keyPathFor(["P2", "P2", "K1", "K1", "P2"])).toEqual([PLANT_KEY, "P2", "K1", "P2"]);
  });

  it("refuses to guess on an unknown or missing zone", () => {
    expect(keyPathFor(["ZZ"])).toBeNull();
    expect(keyPathFor([null])).toBeNull();
    expect(keyPathFor(["P1", undefined])).toBeNull();
  });

  it("returns null when there is no destination at all", () => {
    expect(keyPathFor([])).toBeNull();
  });
});

describe("pointForKey", () => {
  it("maps PLANT to the plant origin and zone codes to their centroids", () => {
    expect(pointForKey(PLANT_KEY)).toEqual(PLANT_ORIGIN);
    expect(pointForKey("A2")).toEqual(ZONE_COORDS.A2);
    expect(pointForKey("nope")).toBeNull();
  });
});

describe("legIsFresh — the staleness guard", () => {
  const from = { latitude: 5.216238509805299, longitude: 100.4445982584094 };
  const to = { latitude: 4.5975, longitude: 101.0901 };
  const leg = { from_lat: from.latitude, from_lng: from.longitude, to_lat: to.latitude, to_lng: to.longitude };

  it("accepts a leg generated for exactly these coordinates", () => {
    expect(legIsFresh(leg, from, to)).toBe(true);
  });

  it("accepts DECIMAL(10,7) rounding noise", () => {
    expect(legIsFresh({ ...leg, from_lat: 5.2162385 }, from, to)).toBe(true);
  });

  it("rejects a leg whose origin has MOVED — the real 2026-07-20 case", () => {
    // Legs generated against the old wrong plant guess must not be trusted.
    expect(legIsFresh({ ...leg, from_lat: 5.466, from_lng: 100.43 }, from, to)).toBe(false);
  });

  it("rejects a moved destination centroid", () => {
    expect(legIsFresh({ ...leg, to_lat: 4.7 }, from, to)).toBe(false);
  });

  it("reads Prisma Decimal-ish values via Number()", () => {
    const decimalish = {
      from_lat: { toString: () => "5.2162385" },
      from_lng: { toString: () => "100.4445983" },
      to_lat: { toString: () => "4.5975000" },
      to_lng: { toString: () => "101.0901000" },
    };
    expect(legIsFresh(decimalish, from, to)).toBe(true);
  });
});

describe("joinLegPolylines", () => {
  const a = [
    { latitude: 1, longitude: 1 },
    { latitude: 2, longitude: 2 },
  ];
  const b = [
    { latitude: 2, longitude: 2 }, // repeats a's last point — the shared centroid
    { latitude: 3, longitude: 3 },
  ];

  it("drops the duplicated joint between legs", () => {
    expect(joinLegPolylines([a, b])).toEqual([
      { latitude: 1, longitude: 1 },
      { latitude: 2, longitude: 2 },
      { latitude: 3, longitude: 3 },
    ]);
  });

  it("passes a single leg through untouched", () => {
    expect(joinLegPolylines([a])).toEqual(a);
  });

  it("handles the empty case", () => {
    expect(joinLegPolylines([])).toEqual([]);
  });
});
