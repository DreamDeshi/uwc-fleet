import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  palletFactor,
  palletEquivalents,
  isUnsizedForDispatch,
  isDeprecatedPalletSize,
  normalizePalletType,
  CARGO_PALLET_TYPES,
  BOOKABLE_CARGO_TYPES,
  BOOKABLE_PALLET_SIZES,
  DEPRECATED_PALLET_SIZES,
  PALLET_SIZES,
  ALWAYS_MANUAL_TYPES,
  DIMENSIONED_CARGO_TYPES,
  DIMENSION_SIZED_TYPES,
  isAlwaysManualType,
  dimensionedEquivalent,
  canonicalCargoSize,
  isValidDimension,
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

// ── Q1 (CLIENT_ANSWERS_R1_2026-07-24): 1×1/1×2 removed from bookable sizes ────
describe("Q1 — 1×1 and 1×2 deprecated as bookable footprints", () => {
  it("DEPRECATED_PALLET_SIZES is exactly the two boxes Mr. Teh removed", () => {
    expect([...DEPRECATED_PALLET_SIZES]).toEqual(["1×1", "1×2"]);
    expect(isDeprecatedPalletSize("1×1")).toBe(true);
    expect(isDeprecatedPalletSize("1×2")).toBe(true);
    expect(isDeprecatedPalletSize("4×4")).toBe(false);
  });

  it("BOOKABLE sizes are PALLET_SIZES minus the deprecated boxes (drift guard)", () => {
    const expected = PALLET_SIZES.filter((s) => !(DEPRECATED_PALLET_SIZES as readonly string[]).includes(s));
    expect([...BOOKABLE_PALLET_SIZES]).toEqual(expected);
    expect(BOOKABLE_PALLET_SIZES).not.toContain("1×1");
    expect(BOOKABLE_PALLET_SIZES).not.toContain("1×2");
  });

  it("the NEW-booking vocabulary excludes 1×1/1×2 and includes the Q10 non-pallet types", () => {
    expect([...BOOKABLE_CARGO_TYPES]).toEqual([
      "2×2", "2×3", "3×3", "3×4", "4×4", "4×8", "5×5", "5×10", "carton", "custom", "box", "crate", "rack",
    ]);
  });

  it("the booking-route enum (z.enum on BOOKABLE_CARGO_TYPES) rejects a new 1×1/1×2 but accepts the rest", () => {
    // Mirrors the route schema, proving frontend/backend agree on what is bookable.
    const enumSchema = z.enum(BOOKABLE_CARGO_TYPES);
    expect(enumSchema.safeParse("1×1").success).toBe(false);
    expect(enumSchema.safeParse("1×2").success).toBe(false);
    for (const ok of ["2×2", "4×4", "5×5", "5×10", "carton", "custom", "box", "crate", "rack"]) {
      expect(enumSchema.safeParse(ok).success, ok).toBe(true);
    }
  });
});

describe("legacy display compatibility — historical 1×1/1×2 rows still resolve", () => {
  it("keeps the deprecated factors so an existing record converts unchanged", () => {
    // A historical CargoDetail row with 1×1/1×2 must NOT become unpriced/zeroed.
    expect(palletFactor("1×1")).toBe(0.0625);
    expect(palletFactor("1×2")).toBe(0.125);
  });

  it("palletEquivalents on a legacy 1×1/1×2 line is unchanged (money logic untouched)", () => {
    expect(palletEquivalents([{ pallet_type: "1×1", quantity: 256 }])).toBe(16);
    expect(palletEquivalents([{ pallet_type: "1×2", quantity: 4 }])).toBe(0.5);
  });

  it("the deprecated sizes remain in the full legacy vocabulary CARGO_PALLET_TYPES", () => {
    expect(CARGO_PALLET_TYPES).toContain("1×1");
    expect(CARGO_PALLET_TYPES).toContain("1×2");
  });
});

describe("Q1 — confirmed footprint factors (5×5 / 3×3 / 2×3)", () => {
  it("matches the values Mr. Teh confirmed correct", () => {
    expect(palletFactor("5×5")).toBe(1.5625);
    expect(palletFactor("3×3")).toBe(0.5625);
    expect(palletFactor("2×3")).toBe(0.375);
  });
});

describe("CARGO_PALLET_TYPES (full/legacy vocabulary — kept for historical rows)", () => {
  it("is exactly the closed vocabulary: 10 pallet sizes + the 5 non-pallet types", () => {
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
      "box",
      "crate",
      "rack",
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

  it("Q10: custom is ALWAYS manual — an estimate can NOT make it auto-dispatch", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "custom", quantity: 1, estimated_pallets: 4 }])).toBe(true);
  });

  it("carton (LEGACY) WITH an estimate still auto-dispatches on the estimate (unchanged)", () => {
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

describe("Q10 — Crate/Custom always route to manual; Box and Rack changed 27 Aug 2026", () => {
  it("ALWAYS_MANUAL_TYPES is crate/custom only (box and rack excluded 27 Aug 2026, carton excluded — legacy)", () => {
    expect([...ALWAYS_MANUAL_TYPES]).toEqual(["crate", "custom"]);
    expect(isAlwaysManualType("carton")).toBe(false);
    expect(isAlwaysManualType("box")).toBe(false);
    expect(isAlwaysManualType("rack")).toBe(false);
    for (const t of ["crate", "custom"]) expect(isAlwaysManualType(t)).toBe(true);
  });

  it("Box NEVER forces manual assignment (owner ruling 27 Aug 2026 — no truck space needed)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "box", quantity: 5 }])).toBe(false);
    expect(isUnsizedForDispatch([{ pallet_type: "box", quantity: 5, estimated_pallets: 4 }])).toBe(false);
  });

  it("Crate ALWAYS forces manual assignment (dims are display-only, not packed — unchanged)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 }])).toBe(true);
  });

  it("Custom ALWAYS forces manual assignment (unchanged)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "custom", quantity: 1, width_ft: 4, length_ft: 3 }])).toBe(true);
  });

  it("Rack WITH valid dims is SIZED and no longer forces manual (owner ruling 27 Aug 2026)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "rack", quantity: 2, width_ft: 5, length_ft: 5 }])).toBe(false);
    // An estimate is irrelevant either way now — the dims ARE the size.
    expect(
      isUnsizedForDispatch([{ pallet_type: "rack", quantity: 2, width_ft: 5, length_ft: 5, estimated_pallets: 999 }])
    ).toBe(false);
  });

  it("Rack WITHOUT valid dims still forces manual (defensive — schema requires dims for a new line)", () => {
    expect(isUnsizedForDispatch([{ pallet_type: "rack", quantity: 2 }])).toBe(true);
    expect(isUnsizedForDispatch([{ pallet_type: "rack", quantity: 2, width_ft: 0, length_ft: 5 }])).toBe(true);
  });

  it("Box/Crate contribute 0 to the pallet-equivalent load (no invented area-summing)", () => {
    expect(palletEquivalents([{ pallet_type: "box", quantity: 9 }])).toBe(0);
    expect(palletEquivalents([{ pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 }])).toBe(0);
  });

  it("Rack contributes AREA ÷ 16 × quantity — the same rule as a pallet footprint", () => {
    // 5×5 = 25/16 = 1.5625 per unit, × 2 = 3.125.
    expect(palletEquivalents([{ pallet_type: "rack", quantity: 2, width_ft: 5, length_ft: 5 }])).toBe(3.125);
    // A rack with no/invalid dims falls back to 0, never a guessed number.
    expect(palletEquivalents([{ pallet_type: "rack", quantity: 2 }])).toBe(0);
  });

  it("DIMENSION_SIZED_TYPES is rack only — crate/custom deliberately excluded", () => {
    expect([...DIMENSION_SIZED_TYPES]).toEqual(["rack"]);
    expect(dimensionedEquivalent({ pallet_type: "crate", width_ft: 4, length_ft: 4 })).toBeNull();
    expect(dimensionedEquivalent({ pallet_type: "custom", width_ft: 4, length_ft: 4 })).toBeNull();
    expect(dimensionedEquivalent({ pallet_type: "rack", width_ft: 4, length_ft: 4 })).toBe(1);
    expect(dimensionedEquivalent({ pallet_type: "rack" })).toBeNull();
  });

  it("a Box line no longer forces manual on an otherwise-sized pallet order", () => {
    expect(
      isUnsizedForDispatch([
        { pallet_type: "4×4", quantity: 2 },
        { pallet_type: "box", quantity: 3 },
      ])
    ).toBe(false);
  });

  it("a Rack line WITH dims lets a mixed pallet+rack order auto-dispatch", () => {
    expect(
      isUnsizedForDispatch([
        { pallet_type: "4×4", quantity: 2 },
        { pallet_type: "rack", quantity: 1, width_ft: 4, length_ft: 4 }, // +1 slot
      ])
    ).toBe(false);
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 2 }, // 2
        { pallet_type: "rack", quantity: 1, width_ft: 4, length_ft: 4 }, // 1
      ])
    ).toBe(3);
  });

  it("a Crate line still forces manual even mixed with sized pallets/rack (unchanged)", () => {
    expect(
      isUnsizedForDispatch([
        { pallet_type: "4×4", quantity: 2 },
        { pallet_type: "rack", quantity: 1, width_ft: 4, length_ft: 4 },
        { pallet_type: "crate", quantity: 1, width_ft: 3, length_ft: 3 },
      ])
    ).toBe(true);
  });

  it("DIMENSIONED_CARGO_TYPES is crate/rack/custom", () => {
    expect([...DIMENSIONED_CARGO_TYPES]).toEqual(["crate", "rack", "custom"]);
  });

  it("canonicalCargoSize renders W × L ft, trimming trailing zeros", () => {
    expect(canonicalCargoSize(4, 3)).toBe("4 × 3 ft");
    expect(canonicalCargoSize(4.5, 3)).toBe("4.5 × 3 ft");
    expect(canonicalCargoSize(4.0, 3.0)).toBe("4 × 3 ft");
  });

  it("isValidDimension rejects 0, negative, NaN and infinities", () => {
    expect(isValidDimension(4)).toBe(true);
    expect(isValidDimension(0.5)).toBe(true);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "4", null, undefined]) {
      expect(isValidDimension(bad)).toBe(false);
    }
  });
});
