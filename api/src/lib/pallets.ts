/**
 * Pallet → 4×4-equivalent conversion (spec AUTO DISPATCH LOGIC: "everything is
 * measured in 4×4 Pallets"). Requestors may book other pallet footprints, so
 * every capacity / load calculation must convert to 4×4 slots first — otherwise
 * a 5×10 pallet (which occupies ~3 slots) would be counted as one.
 *
 * Factors are relative to a single 4×4 pallet (= 1 slot). Pallet-size strings
 * are stored with the "×" (U+00D7) separator exactly as the booking form emits
 * them (see mobile BookingFormScreen PALLET_SIZES).
 */
export const PALLET_FACTORS: Record<string, number> = {
  "2×2": 0.25,
  "3×4": 0.75,
  "4×4": 1,
  "4×8": 2,
  "5×10": 3.125,
};

/** 4×4-equivalent slots for one cargo line's pallet type. */
export function palletFactor(palletType: string): number {
  if (palletType in PALLET_FACTORS) return PALLET_FACTORS[palletType];
  // Cartons and free-form "Others" cargo don't occupy standard pallet slots, so
  // they contribute nothing to the pallet-equivalent load (admin judges these).
  if (palletType === "carton" || palletType === "custom") return 0;
  return 1; // unknown footprint — treat as one standard slot (conservative)
}

/**
 * Total 4×4-pallet-equivalent load for a set of cargo lines. Rounded to 3 dp to
 * keep the 3.125 factor exact while avoiding floating-point noise.
 */
export function palletEquivalents(cargo: { pallet_type: string; quantity: number }[]): number {
  const total = cargo.reduce((sum, c) => sum + palletFactor(c.pallet_type) * c.quantity, 0);
  return Math.round(total * 1000) / 1000;
}
