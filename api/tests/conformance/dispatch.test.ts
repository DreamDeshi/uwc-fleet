/**
 * DISPATCH conformance — pins WHICH truck the engine picks across every zone and
 * a spread of load sizes, plus the A1/A2 primary rule, the smallest-fit
 * (Best-Fit Decreasing) tie-break, capacity overflow, and the manual fallback
 * bands. Expected plates are hand-derived from the workbook rules (NOT
 * re-computed with selectTruck's own algorithm) so a regression in the engine is
 * caught, not mirrored.
 *
 * Fleet + zones + coverage come from docs/uwc-spec.json via ./fixtures, so this
 * tracks the real configured fleet. Adjacency is the seeded P2↔K1 / P2↔A1.
 *
 * ── 28 Jul 2026 fleet revision (values corrected by the R3 answers, 29 Jul) ──
 * The customer/supplier AUTO pool is now: PND 1888 (14, covers A1,A2,P1,P2 —
 * the A1/A2 primary, Azmi's move), PSA 5292 (14, covers P1,P2,P3,K1,K2),
 * PRJ/PQL/PPE 1804 (8s), PRH 5292 (2, covers ALL). PLX 2406 and PPE 2406 are
 * INTERPLANT — never in this pool. Consequences pinned below:
 *   - the pool's largest truck is 14 → every 15–16-pallet band is null
 *     (booking-accept still allows ≤16; the trip falls to manual — the
 *     owner-approved design, R3 A7);
 *   - two 14-pallet trucks now TIE where both cover → alphabetical tie-break
 *     (PND 1888 < PSA 5292);
 *   - the PRH small-load A1/A2 rule is REMOVED (R3 A3) — its physical
 *     max_pallets (2) is the only remaining constraint.
 */
import { describe, it, expect } from "vitest";
import { selectTruck } from "../../src/services/dispatchEngine";
import { DISPATCHABLE, FLEET, ZONES, ADJACENCY, freeFleet, truckByPlate } from "./fixtures";

const pick = (zone: string, pallets: number, exclude: string[] = []) =>
  selectTruck({ zone, pallets }, freeFleet(exclude), ADJACENCY);

const PRIMARY = "PND 1888";

describe("fleet fixture sanity", () => {
  it('"4 Wheel" has no driver and is NOT dispatchable', () => {
    expect(FLEET.find((t) => t.plate === "4 Wheel")!.hasDriver).toBe(false);
    expect(DISPATCHABLE.map((t) => t.plate)).not.toContain("4 Wheel");
  });

  it("the interplant shuttles are OUT of the customer pool even though they have drivers", () => {
    expect(FLEET.find((t) => t.plate === "PLX 2406")!.interplant).toBe(true);
    expect(FLEET.find((t) => t.plate === "PPE 2406")!.interplant).toBe(true);
    expect(DISPATCHABLE.map((t) => t.plate)).not.toContain("PLX 2406");
    expect(DISPATCHABLE.map((t) => t.plate)).not.toContain("PPE 2406");
    expect(freeFleet()).toHaveLength(6); // PND, PSA, PRJ, PQL, PPE 1804, PRH
  });

  it("the customer pool's largest truck is 14 pallets (PLX's 16 left with it)", () => {
    expect(Math.max(...DISPATCHABLE.map((t) => t.maxPallets))).toBe(14);
  });

  it("R3 A5: PSA 5292's weekday rate is the CORRECTED 11, not the workbook's typo 13", () => {
    const psa = truckByPlate("PSA 5292");
    expect(psa.weekday).toBe(11);
    expect(psa.offpeak).toBe(13);
  });
});

describe("pick matrix — full idle fleet, each zone × load band → expected truck", () => {
  // [zone, pallets, expectedPlate | null, note]
  const cases: Array<[string, number, string | null, string]> = [
    // A1/A2: PND 1888 (Azmi) locks these while free — overrides Best-Fit
    // (PRH would be "smaller"), which is the point of the primary rule.
    ["A1", 1, PRIMARY, "A1/A2 → PND primary, beats smallest-fit"],
    ["A1", 2, PRIMARY, "A1/A2 → PND even for a tiny load"],
    ["A2", 6, PRIMARY, "A1/A2 → PND"],
    ["A2", 14, PRIMARY, "A1/A2 → PND at its capacity"],
    ["A2", 15, null, "primary can't fit and neither can anyone else → manual"],
    ["A2", 17, null, "exceeds every truck → no pick"],

    // P1/P2 (both 14s cover): Best-Fit Decreasing among tier-0 coverers,
    // alphabetical tie-break between the equal 14s.
    ["P1", 1, "PRH 5292", "smallest truck that fits (1-tonner)"],
    ["P1", 2, "PRH 5292", "smallest-fit, NOT the biggest free truck"],
    ["P1", 3, "PPE 1804", "PRH too small → smallest 8-pallet truck (alpha tie-break)"],
    ["P1", 8, "PPE 1804", "smallest 8-pallet truck"],
    ["P1", 9, PRIMARY, "8s don't fit → the 14s tie; alpha: PND 1888 < PSA 5292"],
    ["P1", 14, PRIMARY, "14-pallet tie → alpha tie-break"],
    ["P1", 15, null, "nothing in the customer pool fits 15 → manual (R3 A7 design)"],
    ["P1", 16, null, "accepted at booking (fleet max 16 incl. PLX) but auto-unfulfillable"],
    ["P1", 17, null, "exceeds fleet"],
    ["P2", 1, "PRH 5292", "same coverage as P1"],
    ["P2", 9, PRIMARY, "same tie-break as P1"],

    // P3/K1/K2: PSA covers (tier 0); PND does NOT (its zones are A1,A2,P1,P2
    // now) — PND is adjacent via P2 for K1/A1 only, else tier 2. Either way
    // PSA outranks it for the 9–14 band.
    ["P3", 1, "PRH 5292", "covers zone, smallest-fit"],
    ["P3", 3, "PPE 1804", "smallest 8-pallet"],
    ["P3", 9, "PSA 5292", "PSA covers P3; PND doesn't → PSA despite alpha"],
    ["P3", 14, "PSA 5292", "coverage beats the tie-break"],
    ["P3", 15, null, "manual band"],
    ["K1", 1, "PRH 5292", "covers, smallest-fit"],
    ["K1", 9, "PSA 5292", "PSA covers K1; PND merely adjacent (K1↔P2)"],
    ["K1", 15, null, "manual band"],
    ["K2", 1, "PRH 5292", "covers, smallest-fit"],
    ["K2", 9, "PSA 5292", "PSA covers K2; PND tier-2"],
    ["K2", 15, null, "manual band"],

    // KL: no truck lists KL as a priority zone → pure Best-Fit (all any-tier),
    // so the equal 14s tie-break alphabetically.
    ["KL", 1, "PRH 5292", "KL uncovered → smallest-fit"],
    ["KL", 3, "PPE 1804", "smallest 8-pallet"],
    ["KL", 9, PRIMARY, "14s tie at tier-2 → alpha"],
    ["KL", 15, null, "manual band"],
    ["KL", 17, null, "exceeds fleet"],
  ];

  for (const [zone, pallets, expected, note] of cases) {
    it(`${zone} × ${pallets} pallets → ${expected ?? "no truck"} (${note})`, () => {
      const sel = pick(zone, pallets);
      expect(sel?.plate ?? null).toBe(expected);
    });
  }
});

describe("A1/A2 with the primary unavailable — no named backup, no PRH rule (R3 A2/A3)", () => {
  it("A2 × 1 with PND out → PRH 5292 (covers A2 + smallest fit)", () => {
    expect(pick("A2", 1, [PRIMARY])?.plate).toBe("PRH 5292");
  });
  it("REGRESSION (R3 A3): A2 × 2 with PND out → PRH 5292 — the strictly-under-2 cap is gone", () => {
    // Under the removed rule this order skipped PRH and went to the old backup.
    expect(pick("A2", 2, [PRIMARY])?.plate).toBe("PRH 5292");
  });
  it("A2 × 3 with PND out → PPE 1804 (PRH too small; 8s tie → alpha)", () => {
    expect(pick("A2", 3, [PRIMARY])?.plate).toBe("PPE 1804");
  });
  it("A2 × 9 with PND out → PSA 5292 (the only remaining 14)", () => {
    expect(pick("A2", 9, [PRIMARY])?.plate).toBe("PSA 5292");
  });
  it("A2 × 15 with PND out → no truck (nothing in the pool holds 15)", () => {
    expect(pick("A2", 15, [PRIMARY])).toBeNull();
  });
});

describe("invariants — must hold for every zone and every load 1..16", () => {
  const poolMax = Math.max(...DISPATCHABLE.map((t) => t.maxPallets));
  for (const zone of ZONES) {
    it(`${zone}: any pick fits the load, respects the A1/A2 primary lock, and null iff nothing fits`, () => {
      for (let pallets = 1; pallets <= 16; pallets++) {
        const sel = pick(zone, pallets);
        if (sel) {
          // Chosen truck always has capacity for the order.
          expect(truckByPlate(sel.plate).maxPallets).toBeGreaterThanOrEqual(pallets);
          // With the full pool idle, the A1/A2 primary lock fires whenever
          // PND fits; a pick above PND's capacity is impossible (pool max 14).
          if ((zone === "A1" || zone === "A2") && pallets <= truckByPlate(PRIMARY).maxPallets) {
            expect(sel.plate).toBe(PRIMARY);
          }
          // The interplant shuttles and the driverless spare never appear.
          expect(["PLX 2406", "PPE 2406", "4 Wheel"]).not.toContain(sel.plate);
        } else {
          // A null pick must mean no truck in the CUSTOMER pool could hold the
          // load — which since the revision includes the whole 15–16 band.
          expect(pallets).toBeGreaterThan(poolMax);
        }
      }
    });
  }
});
