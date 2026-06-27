import { describe, it, expect } from "vitest";
import { palletFactor, palletEquivalents } from "../src/lib/pallets";

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
