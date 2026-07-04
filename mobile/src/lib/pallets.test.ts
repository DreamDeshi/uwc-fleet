import { describe, expect, it } from "vitest";
import { PALLET_FACTORS, palletEquivalents, palletFactor } from "./pallets";

// These factors MUST stay identical to api/src/lib/pallets.ts — the server
// enforces capacity in 4×4-equivalents, and the booking form warns with this
// mirror. The literals below are the spec table (master doc §11).
describe("pallet factors mirror the server", () => {
  it("matches the spec conversion table exactly", () => {
    expect(PALLET_FACTORS).toEqual({
      "2×2": 0.25,
      "3×4": 0.75,
      "4×4": 1,
      "4×8": 2,
      "5×10": 3.125,
    });
  });

  it("cartons/custom occupy no pallet slots; unknown types one (conservative)", () => {
    expect(palletFactor("carton")).toBe(0);
    expect(palletFactor("custom")).toBe(0);
    expect(palletFactor("6×6")).toBe(1);
  });
});

describe("booking-form warning cases (audit finding 4.2)", () => {
  it("6× 5×10 is 18.75 equivalents — MUST warn (server rejects >16)", () => {
    expect(palletEquivalents([{ pallet_type: "5×10", quantity: 6 }])).toBe(18.75);
  });

  it("16× 2×2 is only 4 equivalents — must NOT warn", () => {
    expect(palletEquivalents([{ pallet_type: "2×2", quantity: 16 }])).toBe(4);
  });

  it("mixed lines sum in slots, not units", () => {
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 3 },
        { pallet_type: "4×8", quantity: 2 },
        { pallet_type: "2×2", quantity: 4 },
      ])
    ).toBe(8);
  });
});
