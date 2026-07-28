/**
 * DISPATCH conformance — pins WHICH truck the engine picks across every zone and
 * a spread of load sizes, plus the A1/A2 named-plate rules, the smallest-fit
 * (Best-Fit Decreasing) tie-break, capacity overflow, and the soft-priority
 * fallback. Expected plates are hand-derived from the workbook rules (NOT
 * re-computed with selectTruck's own algorithm) so a regression in the engine is
 * caught, not mirrored.
 *
 * Fleet + zones + coverage come from docs/uwc-spec.json via ./fixtures, so this
 * tracks the real configured fleet. Adjacency is the seeded P2↔K1 / P2↔A1.
 */
import { describe, it, expect } from "vitest";
import { selectTruck } from "../../src/services/dispatchEngine";
import { DISPATCHABLE, FLEET, ZONES, ADJACENCY, freeFleet, truckByPlate } from "./fixtures";

const pick = (zone: string, pallets: number, exclude: string[] = []) =>
  selectTruck({ zone, pallets }, freeFleet(exclude), ADJACENCY);

describe("fleet fixture sanity", () => {
  it('"4 Wheel" has no driver and is NOT dispatchable; the pool is the 6 driver-bound trucks', () => {
    expect(FLEET.find((t) => t.plate === "4 Wheel")!.hasDriver).toBe(false);
    expect(DISPATCHABLE.map((t) => t.plate)).not.toContain("4 Wheel");
    expect(freeFleet()).toHaveLength(6);
  });
});

describe("pick matrix — full idle fleet, each zone × load band → expected truck", () => {
  // [zone, pallets, expectedPlate | null, note]
  const cases: Array<[string, number, string | null, string]> = [
    // A1/A2: the INTERNAL LORRY RATE sheet locks these to PLX 2406 while it's free
    // — this overrides Best-Fit (PRH would be "smaller"), which is the point.
    ["A1", 1, "PLX 2406", "A1/A2 → PLX primary, beats smallest-fit"],
    ["A1", 2, "PLX 2406", "A1/A2 → PLX even for a tiny load"],
    ["A2", 6, "PLX 2406", "A1/A2 → PLX"],
    ["A2", 16, "PLX 2406", "A1/A2 → PLX at full capacity"],
    ["A2", 17, null, "exceeds every truck → no pick"],

    // P1/P2 (PLX covers these): Best-Fit Decreasing among tier-0 coverers.
    ["P1", 1, "PRH 5292", "smallest truck that fits (1-tonner)"],
    ["P1", 2, "PRH 5292", "smallest-fit, NOT the biggest free truck"],
    ["P1", 3, "PPE 1804", "PRH too small → smallest 8-pallet truck (alpha tie-break)"],
    ["P1", 8, "PPE 1804", "smallest 8-pallet truck"],
    ["P1", 9, "PND 1888", "8-trucks don't fit → 14-pallet"],
    ["P1", 14, "PND 1888", "14-pallet"],
    ["P1", 15, "PLX 2406", "only the 16-pallet fits"],
    ["P1", 16, "PLX 2406", "16-pallet at capacity"],
    ["P1", 17, null, "exceeds fleet"],
    ["P2", 1, "PRH 5292", "same coverage as P1"],
    ["P2", 9, "PND 1888", "same coverage as P1"],

    // P3/K1/K2 (PLX does NOT cover): same size ladder, but the 15–16 band falls
    // back to PLX as adjacent (K1, via P2) or any-free (P3/K2) — soft priority.
    ["P3", 1, "PRH 5292", "covers zone, smallest-fit"],
    ["P3", 3, "PPE 1804", "smallest 8-pallet"],
    ["P3", 9, "PND 1888", "14-pallet"],
    ["P3", 15, "PLX 2406", "any-free fallback (PLX doesn't cover P3 but is the only fit)"],
    ["K1", 1, "PRH 5292", "covers, smallest-fit"],
    ["K1", 15, "PLX 2406", "adjacent fallback (K1↔P2)"],
    ["K2", 1, "PRH 5292", "covers, smallest-fit"],
    ["K2", 15, "PLX 2406", "any-free fallback"],

    // KL: no truck lists KL as a priority zone → pure Best-Fit (all any-tier).
    ["KL", 1, "PRH 5292", "KL uncovered → smallest-fit"],
    ["KL", 3, "PPE 1804", "smallest 8-pallet"],
    ["KL", 9, "PND 1888", "14-pallet"],
    ["KL", 15, "PLX 2406", "only fit"],
    ["KL", 17, null, "exceeds fleet"],
  ];

  for (const [zone, pallets, expected, note] of cases) {
    it(`${zone} × ${pallets} pallets → ${expected ?? "no truck"} (${note})`, () => {
      const sel = pick(zone, pallets);
      expect(sel?.plate ?? null).toBe(expected);
    });
  }
});

describe("A1/A2 fallback when PLX 2406 is unavailable (busy/out)", () => {
  it("A2 × 1 with PLX out → PRH 5292 (small-load backup, under 2 pallets)", () => {
    expect(pick("A2", 1, ["PLX 2406"])?.plate).toBe("PRH 5292");
  });
  it("A2 × 2 with PLX out → PND 1888 (PRH barred at ≥2 pallets on A1/A2)", () => {
    expect(pick("A2", 2, ["PLX 2406"])?.plate).toBe("PND 1888");
  });
  it("A2 × 3 with PLX out → PND 1888 (the any-size A1/A2 backup)", () => {
    expect(pick("A2", 3, ["PLX 2406"])?.plate).toBe("PND 1888");
  });
  it("A2 × 15 with PLX out → no truck (capacity: PND holds 14, the 17.5ft lorries 8)", () => {
    expect(pick("A2", 15, ["PLX 2406"])).toBeNull();
  });
});

describe("A1/A2 last-resort fallback — priorities order the fleet, they are not a fence (client, 28 Jul 2026)", () => {
  // "all lorry will go to taiping / ipoh, depend on arrangement and cargo size"
  // — with every priority truck out, any fitting truck may take the order.
  // Pre-28-Jul these orders returned null and went to manual.
  it("A2 × 2 with PLX + PND out → a 17.5ft lorry (PPE 1804, alpha tie-break), never PRH at its cap", () => {
    const sel = pick("A2", 2, ["PLX 2406", "PND 1888"]);
    expect(sel?.plate).toBe("PPE 1804");
  });
  it("A1 × 4 with PLX + PND out → PPE 1804 (P2-adjacent 8-pallet lorry)", () => {
    expect(pick("A1", 4, ["PLX 2406", "PND 1888"])?.plate).toBe("PPE 1804");
  });
  it("A2 × 1 with PLX + PND out → PRH 5292 (small-load priority still beats the fallback)", () => {
    expect(pick("A2", 1, ["PLX 2406", "PND 1888"])?.plate).toBe("PRH 5292");
  });
  it("A2 × 2 with ONLY PRH free → no truck (the <2-pallet cargo cap fails closed even as last resort)", () => {
    expect(pick("A2", 2, ["PLX 2406", "PND 1888", "PRJ 5292", "PQL 5292", "PPE 1804"])).toBeNull();
  });
});

describe("invariants — must hold for every zone and every load 1..16", () => {
  for (const zone of ZONES) {
    it(`${zone}: any pick fits the load, respects A1/A2 eligibility, and null iff nothing fits`, () => {
      for (let pallets = 1; pallets <= 16; pallets++) {
        const sel = pick(zone, pallets);
        if (sel) {
          // Chosen truck always has capacity for the order.
          expect(truckByPlate(sel.plate).maxPallets).toBeGreaterThanOrEqual(pallets);
          // With the full fleet idle, PLX 2406 is free and fits any 1..16 load,
          // so its A1/A2 primary LOCK must always fire here. (The named-plate
          // rule is a priority ordering, not a fence — 28 Jul 2026 widening —
          // but the lock while PLX is free is unchanged.)
          if (zone === "A1" || zone === "A2") {
            expect(sel.plate).toBe("PLX 2406");
          }
          // 4 Wheel is never dispatched.
          expect(sel.plate).not.toBe("4 Wheel");
        } else {
          // A null pick must mean no dispatchable truck could hold the load
          // (the only in-range reason across the idle fleet).
          const anyFits = DISPATCHABLE.some((t) => t.maxPallets >= pallets);
          const a1a2Blocked =
            (zone === "A1" || zone === "A2") &&
            // A1/A2 with a load only PLX could hold is fine; null here only if even PLX can't.
            !DISPATCHABLE.some(
              (t) => t.plate === "PLX 2406" && t.maxPallets >= pallets
            );
          expect(anyFits && !a1a2Blocked).toBe(false);
        }
      }
    });
  }
});
