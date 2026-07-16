import { describe, expect, it } from "vitest";
import { totalPallets } from "./trip";
import type { Trip } from "../types";

/**
 * The pallet→4×4 conversion is duplicated across four files (api/src/lib/pallets,
 * mobile/src/lib/pallets, admin/src/lib/trip, and this one). Commit `802e032`
 * fixed the unknown-type guess in three of them and missed THIS one, so the two
 * admin surfaces disagreed about the same load — 1 slot on the phone, 0 on the
 * PC. These tests pin the shared contract on the copy that got left behind.
 *
 * Dispatch/capacity math is NOT affected by this file (api/src/lib/pallets.ts is
 * canonical and enforces the enum) — this is the admin's display total.
 */
const trip = (cargo: { pallet_type: string; quantity: number }[]) =>
  ({ cargo_details: cargo } as unknown as Trip);

describe("totalPallets — 4×4-equivalents (mirrors api/src/lib/pallets.ts)", () => {
  it("converts each bookable pallet size at its spec factor", () => {
    expect(totalPallets(trip([{ pallet_type: "2×2", quantity: 4 }]))).toBe(1);
    expect(totalPallets(trip([{ pallet_type: "3×4", quantity: 4 }]))).toBe(3);
    expect(totalPallets(trip([{ pallet_type: "4×4", quantity: 4 }]))).toBe(4);
    expect(totalPallets(trip([{ pallet_type: "4×8", quantity: 4 }]))).toBe(8);
    expect(totalPallets(trip([{ pallet_type: "5×10", quantity: 4 }]))).toBe(12.5);
  });

  it("gives cartons and custom/Others no pallet footprint", () => {
    expect(totalPallets(trip([{ pallet_type: "carton", quantity: 50 }]))).toBe(0);
    expect(totalPallets(trip([{ pallet_type: "custom", quantity: 1 }]))).toBe(0);
  });

  // The regression `802e032` left behind here: guessing one slot for an unknown
  // footprint is the UNSAFE direction (a 6×6 is ~2.25 slots, an ASCII "5x10" is
  // 3.125), and it made this surface disagree with admin/src/lib/trip.ts.
  it("gives an unrecognised footprint no slots rather than guessing one", () => {
    expect(totalPallets(trip([{ pallet_type: "6×6", quantity: 1 }]))).toBe(0);
    expect(totalPallets(trip([{ pallet_type: "5x10", quantity: 6 }]))).toBe(0); // ASCII x
  });

  it("keeps the 3.125 factor exact and free of float noise", () => {
    expect(totalPallets(trip([{ pallet_type: "5×10", quantity: 3 }]))).toBe(9.375);
  });

  it("sums mixed cargo lines", () => {
    expect(
      totalPallets(
        trip([
          { pallet_type: "4×4", quantity: 2 }, // 2
          { pallet_type: "5×10", quantity: 2 }, // 6.25
          { pallet_type: "carton", quantity: 30 }, // 0
        ])
      )
    ).toBe(8.25);
  });
});
