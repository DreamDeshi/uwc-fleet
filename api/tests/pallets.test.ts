import { describe, it, expect } from "vitest";
import {
  palletFactor,
  palletEquivalents,
  isUnsizedForDispatch,
  normalizePalletType,
  CARGO_PALLET_TYPES,
  PALLET_SIZES,
} from "../src/lib/pallets";

describe("normalizePalletType — spelling only, not vocabulary", () => {
  it("maps ASCII x/X and strips whitespace to the canonical × key", () => {
    expect(normalizePalletType("5x10")).toBe("5×10");
    expect(normalizePalletType("5 x 10")).toBe("5×10");
    expect(normalizePalletType("4X8")).toBe("4×8");
    expect(normalizePalletType(" 2 X 2 ")).toBe("2×2");
  });

  it("leaves already-canonical keys and carton/custom untouched", () => {
    expect(normalizePalletType("5×10")).toBe("5×10");
    expect(normalizePalletType("carton")).toBe("carton");
    expect(normalizePalletType("custom")).toBe("custom");
  });

  it("only fixes the separator — an unknown footprint stays unknown", () => {
    // "6x6" → "6×6": still not a bookable size, so the enum (not this fn) rejects it.
    expect(normalizePalletType("6x6")).toBe("6×6");
    expect(CARGO_PALLET_TYPES).not.toContain(normalizePalletType("6x6"));
  });
});

describe("palletFactor", () => {
  it("maps each booking pallet size to its 4×4-equivalent", () => {
    expect(palletFactor("2×2")).toBe(0.25);
    expect(palletFactor("3×4")).toBe(0.75);
    expect(palletFactor("4×4")).toBe(1);
    expect(palletFactor("4×8")).toBe(2);
    expect(palletFactor("5×10")).toBe(3.125);
    // Added by item 2 (Mr. Teh, 17 Jul 2026).
    expect(palletFactor("5×5")).toBe(1.5625);
    expect(palletFactor("2×3")).toBe(0.375);
    expect(palletFactor("3×3")).toBe(0.5625);
    expect(palletFactor("1×1")).toBe(0.0625);
    expect(palletFactor("1×2")).toBe(0.125);
  });

  it("derives EVERY factor from area ÷ 16 — the rule, not a per-size table", () => {
    // This is the property that let item 2's five new sizes be derived rather
    // than guessed: all five pre-existing factors already satisfied it exactly.
    // A future size is only correct if it satisfies it too.
    for (const size of PALLET_SIZES) {
      const [w, h] = size.split("×").map(Number);
      expect(palletFactor(size), `${size} = ${w}×${h}/16`).toBe((w * h) / 16);
    }
  });

  it("treats cartons and custom/Others cargo as occupying no pallet slot", () => {
    expect(palletFactor("carton")).toBe(0);
    expect(palletFactor("custom")).toBe(0);
  });

  // Guessing one slot for an unknown footprint is the UNSAFE direction: a 6×6 is
  // ~2.25 slots and a wrong-encoding ASCII "5x10" is 3.125, so a guessed 1
  // under-counts and overloads the truck. Unknown → no footprint → the order is
  // unsized and routes to manual assignment (see isUnsizedForDispatch).
  it("gives an unrecognised footprint no slots rather than guessing one", () => {
    expect(palletFactor("6×6")).toBe(0);
    expect(palletFactor("5x10")).toBe(0); // ASCII "x" — not the U+00D7 key
  });

  it("treats an unrecognised footprint as unsized, so it can't auto-dispatch", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "5x10", quantity: 6 }])).toBe(true);
    expect(isUnsizedForDispatch([{ pallet_type: "6×6", quantity: 1 }])).toBe(true);
  });
});

describe("CARGO_PALLET_TYPES (the route's enum)", () => {
  it("is exactly the closed vocabulary: 10 pallet sizes + carton/Others", () => {
    expect([...CARGO_PALLET_TYPES]).toEqual([
      "1×1",
      "1×2",
      "2×2",
      "2×3",
      "3×3",
      "3×4",
      "4×4",
      "4×8",
      "5×5",
      "5×10",
      "carton",
      "custom",
    ]);
  });

  it("round-trips every new size from the ASCII spelling a caller would send", () => {
    // The workbook prints an ASCII x, so "5x5"/"1x2" are what arrives in
    // practice; each must normalise onto its U+00D7 key and hit a real factor.
    for (const [ascii, canonical] of [
      ["5x5", "5×5"],
      ["2x3", "2×3"],
      ["3x3", "3×3"],
      ["1x1", "1×1"],
      ["1 X 2", "1×2"],
    ] as const) {
      expect(normalizePalletType(ascii)).toBe(canonical);
      expect(palletFactor(normalizePalletType(ascii))).toBeGreaterThan(0);
    }
  });

  it("gives every bookable pallet size a factor (no size can enter unpriced)", () => {
    for (const size of PALLET_SIZES) expect(palletFactor(size)).toBeGreaterThan(0);
  });
});

describe("palletEquivalents — 4 dp, because every factor is a sixteenth", () => {
  it("does NOT round the finest factor away (1×1 stays 0.0625, not 0.063)", () => {
    // The rounding was 3 dp, chosen when 2×2's 0.25 was the smallest factor.
    // Item 2's 1×1 is 1/16 = 0.0625, which 3 dp corrupts on the way out.
    expect(palletEquivalents([{ pallet_type: "1×1", quantity: 1 }])).toBe(0.0625);
    expect(palletEquivalents([{ pallet_type: "3×3", quantity: 1 }])).toBe(0.5625);
    expect(palletEquivalents([{ pallet_type: "5×5", quantity: 1 }])).toBe(1.5625);
  });

  it("keeps a sum of the new sizes exact (every total is some m/16)", () => {
    // 3×0.0625 + 1×0.375 + 1×0.5625 = 0.1875 + 0.375 + 0.5625 = 1.125
    expect(
      palletEquivalents([
        { pallet_type: "1×1", quantity: 3 },
        { pallet_type: "2×3", quantity: 1 },
        { pallet_type: "3×3", quantity: 1 },
      ])
    ).toBe(1.125);
  });

  it("16× 5×5 = 25 slots — over a PLX 2406's 16, so a real load is caught", () => {
    expect(palletEquivalents([{ pallet_type: "5×5", quantity: 16 }])).toBe(25);
  });

  it("256× 1×1 = exactly 16 slots (the ~256-per-truck figure that makes 1×1 doubtful)", () => {
    // Pinned as arithmetic, not endorsement: 0.0625 implying 256 to a truck is
    // why 1×1/1×2 are flagged unconfirmed as PALLET types (may be cartons).
    expect(palletEquivalents([{ pallet_type: "1×1", quantity: 256 }])).toBe(16);
  });
});

describe("palletEquivalents", () => {
  it("sums factor × quantity across cargo lines", () => {
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 4 }, // 4
        { pallet_type: "5×10", quantity: 2 }, // 6.25
      ])
    ).toBe(10.25);
  });

  it("excludes cartons from the pallet-equivalent load", () => {
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 2 },
        { pallet_type: "carton", quantity: 50 },
      ])
    ).toBe(2);
  });

  it("keeps the 3.125 factor exact and free of float noise", () => {
    expect(palletEquivalents([{ pallet_type: "5×10", quantity: 3 }])).toBe(9.375);
  });
});

describe("palletEquivalents — carton/Others use the requestor estimate", () => {
  it("uses estimated_pallets as the line's equivalent for a custom (Others) line", () => {
    expect(palletEquivalents([{ pallet_type: "custom", quantity: 1, estimated_pallets: 5 }])).toBe(5);
  });

  it("uses estimated_pallets for a carton line (the whole-line estimate, not quantity)", () => {
    expect(palletEquivalents([{ pallet_type: "carton", quantity: 50, estimated_pallets: 3 }])).toBe(3);
  });

  it("mixes an estimated Others line with pallet lines", () => {
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 2 }, // 2
        { pallet_type: "custom", quantity: 1, estimated_pallets: 4 }, // 4
      ])
    ).toBe(6);
  });

  it("still contributes 0 when carton/custom has no estimate (unchanged)", () => {
    expect(palletEquivalents([{ pallet_type: "custom", quantity: 1 }])).toBe(0);
    expect(palletEquivalents([{ pallet_type: "carton", quantity: 50 }])).toBe(0);
  });
});

describe("isUnsizedForDispatch — unsized carton/Others route to manual assignment", () => {
  it("custom (Others) with no estimate is unsized → manual", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "custom", quantity: 1 }])).toBe(true);
  });

  it("carton with no estimate is unsized → manual", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "carton", quantity: 50 }])).toBe(true);
  });

  it("custom WITH an estimate is sized → auto-dispatches on the estimate", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "custom", quantity: 1, estimated_pallets: 4 }])).toBe(false);
  });

  it("carton WITH an estimate is sized → auto-dispatches on the estimate", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "carton", quantity: 50, estimated_pallets: 3 }])).toBe(false);
  });

  it("pallet cargo is never unsized (unchanged behaviour)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "4×4", quantity: 4 }])).toBe(false);
    expect(isUnsizedForDispatch([{ pallet_type: "5×10", quantity: 2 }])).toBe(false);
  });

  it("a zero or null estimate counts as unsized", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "custom", quantity: 1, estimated_pallets: 0 }])).toBe(true);
    expect(isUnsizedForDispatch([{ pallet_type: "carton", quantity: 5, estimated_pallets: null }])).toBe(true);
  });

  it("any unsized line makes a mixed order unsized", () => {
    expect(
      isUnsizedForDispatch([
        { pallet_type: "4×4", quantity: 2 },
        { pallet_type: "custom", quantity: 1 }, // no estimate
      ])
    ).toBe(true);
  });
});
