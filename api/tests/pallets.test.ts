import { describe, it, expect } from "vitest";
import { palletFactor, palletEquivalents, isUnsizedForDispatch } from "../src/lib/pallets";

describe("palletFactor", () => {
  it("maps each booking pallet size to its 4×4-equivalent", () => {
    expect(palletFactor("2×2")).toBe(0.25);
    expect(palletFactor("3×4")).toBe(0.75);
    expect(palletFactor("4×4")).toBe(1);
    expect(palletFactor("4×8")).toBe(2);
    expect(palletFactor("5×10")).toBe(3.125);
  });

  it("treats cartons and custom/Others cargo as occupying no pallet slot", () => {
    expect(palletFactor("carton")).toBe(0);
    expect(palletFactor("custom")).toBe(0);
  });

  it("falls back to one slot for an unrecognised footprint (conservative)", () => {
    expect(palletFactor("6×6")).toBe(1);
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
