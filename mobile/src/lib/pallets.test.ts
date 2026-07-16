import { describe, expect, it } from "vitest";
import { CARGO_PALLET_TYPES, PALLET_FACTORS, palletEquivalents, palletFactor } from "./pallets";

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

  it("gives cartons/custom and any unrecognised footprint no slots", () => {
    expect(palletFactor("carton")).toBe(0);
    expect(palletFactor("custom")).toBe(0);
    // Guessing one slot for an unknown is the UNSAFE direction — a 6×6 is ~2.25
    // slots and an ASCII "5x10" is really 3.125, so a guessed 1 under-counts and
    // the form would stay silent on a load that overloads the truck. The server
    // enums pallet_type, so these can't be booked at all.
    expect(palletFactor("6×6")).toBe(0);
    expect(palletFactor("5x10")).toBe(0); // ASCII "x" — not the U+00D7 key
  });

  it("offers exactly the workbook's bookable vocabulary", () => {
    expect([...CARGO_PALLET_TYPES]).toEqual(["2×2", "3×4", "4×4", "4×8", "5×10", "carton", "custom"]);
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
