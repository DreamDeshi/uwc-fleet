import { describe, it, expect } from "vitest";
import {
  consolidationSavings,
  consolidationSavingsFromTotals,
} from "../src/lib/consolidationSavings";

const cfg = { kmPerDelivery: 35, litresPer100km: 30, co2ePerLitre: 2.68 };

describe("consolidationSavings", () => {
  it("counts extra drops that shared a trip as trips saved (exact)", () => {
    // 3 trips carrying 1, 2, 3 drops = 6 drops in 3 trips → 3 fewer trips.
    const s = consolidationSavings([1, 2, 3], cfg);
    expect(s.trips).toBe(3);
    expect(s.drops).toBe(6);
    expect(s.tripsSaved).toBe(3);
    // Estimates: 3 × 35 = 105 km; 105 × 30/100 = 31.5 L; 31.5 × 2.68 = 84.42 kg.
    expect(s.estKmSaved).toBe(105);
    expect(s.estLitresSaved).toBe(31.5);
    expect(s.estCo2eKgSaved).toBe(84.42);
  });

  it("all single-drop trips → no consolidation, zero saved", () => {
    const s = consolidationSavings([1, 1, 1, 1], cfg);
    expect(s.tripsSaved).toBe(0);
    expect(s.estCo2eKgSaved).toBe(0);
  });

  it("no trips → all zero (no division issues)", () => {
    const s = consolidationSavings([], cfg);
    expect(s).toMatchObject({ trips: 0, drops: 0, tripsSaved: 0, estKmSaved: 0, estCo2eKgSaved: 0 });
  });
});

describe("consolidationSavingsFromTotals", () => {
  it("agrees with the per-trip form on the same data", () => {
    // The route counts two scalars instead of fetching every completed trip;
    // the two entry points must not drift.
    expect(consolidationSavingsFromTotals(3, 6, cfg)).toEqual(consolidationSavings([1, 2, 3], cfg));
  });

  it("floors at zero when more trips are counted than drops", () => {
    // Unreachable through the route — it only counts trips that delivered
    // something — but the floor is the backstop for exactly that mistake, and
    // a NEGATIVE saving would render as "-1 trips saved" on the report.
    const s = consolidationSavingsFromTotals(5, 2, cfg);
    expect(s.tripsSaved).toBe(0);
    expect(s.estKmSaved).toBe(0);
    expect(s.estCo2eKgSaved).toBe(0);
  });
});
