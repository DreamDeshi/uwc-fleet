import { describe, it, expect } from "vitest";
import { ghostPositions, primaryZone, ZONE_BY_CODE } from "./zones";

// Ghost markers are placeholders on a zone centroid. Several trucks in one zone
// used to be offset by a hash of their own plate — independent of each other,
// so they could still land on top of one another (three P1 trucks piled up
// unreadably over George Town, 2026-07-20). These tests pin the fix.
const truck = (plate: string, ...zones: string[]) => ({ plate, priority_zones: zones });

describe("primaryZone", () => {
  it("takes the first RECOGNISED zone", () => {
    expect(primaryZone(["K1", "P1"])).toBe("K1");
    expect(primaryZone(["ZZ", "P3"])).toBe("P3"); // unknown code skipped
  });

  it("defaults to P2 when there are no usable zones", () => {
    expect(primaryZone([])).toBe("P2");
    expect(primaryZone(["ZZ"])).toBe("P2");
  });
});

describe("ghostPositions", () => {
  it("puts a lone truck exactly on its zone centroid", () => {
    const pos = ghostPositions([truck("PLX 2406", "A1")]);
    expect(pos["PLX 2406"]).toEqual([ZONE_BY_CODE.A1.lat, ZONE_BY_CODE.A1.lng]);
  });

  it("never places two co-zone trucks at the same point", () => {
    const plates = ["AAA 1", "AAA 2", "AAA 3", "AAA 4", "AAA 5"];
    const pos = ghostPositions(plates.map((p) => truck(p, "P1")));
    const seen = new Set(plates.map((p) => pos[p].join(",")));
    expect(seen.size).toBe(plates.length);
  });

  it("spreads co-zone trucks far enough apart to read (>= ~4km)", () => {
    // The regression: three P1 trucks whose labels collided on screen.
    const pos = ghostPositions([truck("PPE 1804", "P1"), truck("PRH 5292", "P1"), truck("PRJ 5292", "P1")]);
    const pts = Object.values(pos);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dLat = pts[i][0] - pts[j][0];
        const dLng = pts[i][1] - pts[j][1];
        const degrees = Math.hypot(dLat, dLng);
        expect(degrees).toBeGreaterThan(0.04); // ~4.4 km at this latitude
      }
    }
  });

  it("keeps every ghost within its own zone's neighbourhood", () => {
    const pos = ghostPositions([truck("A", "K2"), truck("B", "K2")]);
    for (const [lat, lng] of Object.values(pos)) {
      expect(Math.abs(lat - ZONE_BY_CODE.K2.lat)).toBeLessThan(0.06);
      expect(Math.abs(lng - ZONE_BY_CODE.K2.lng)).toBeLessThan(0.06);
    }
  });

  it("is stable regardless of input order — a truck must not jump", () => {
    const a = ghostPositions([truck("X 1", "P1"), truck("X 2", "P1"), truck("X 3", "P1")]);
    const b = ghostPositions([truck("X 3", "P1"), truck("X 1", "P1"), truck("X 2", "P1")]);
    expect(b).toEqual(a);
  });

  it("groups independently per zone", () => {
    const pos = ghostPositions([truck("P 1", "P1"), truck("K 1", "K1")]);
    // Each is alone in its own zone, so each sits on its own centroid.
    expect(pos["P 1"]).toEqual([ZONE_BY_CODE.P1.lat, ZONE_BY_CODE.P1.lng]);
    expect(pos["K 1"]).toEqual([ZONE_BY_CODE.K1.lat, ZONE_BY_CODE.K1.lng]);
  });
});
