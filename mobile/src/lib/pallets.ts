// Pallet → 4×4-equivalent conversion — MIRROR of api/src/lib/pallets.ts (spec
// AUTO DISPATCH LOGIC: "everything is measured in 4×4 Pallets"). The server
// validates capacity in these units, so the booking form's over-capacity
// warning must count the same way or it warns on loads that fit (16× 2×2 = 4
// slots) and stays silent on loads that don't (6× 5×10 = 18.75 slots).
// Pure module (no React Native imports) — unit-tested in pallets.test.ts.
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
  // Cartons and free-form "Others" cargo don't occupy standard pallet slots.
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
