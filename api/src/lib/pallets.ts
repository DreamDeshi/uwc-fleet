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
  // they have no footprint by conversion — auto-dispatch can only size them from
  // the requestor's estimate (see palletEquivalents / isUnsizedForDispatch).
  if (isUnsizedType(palletType)) return 0;
  return 1; // unknown footprint — treat as one standard slot (conservative)
}

/**
 * "carton" and "custom" (Others) cargo carry no pallet footprint by conversion,
 * so they need the requestor's optional `estimated_pallets` to be dispatchable.
 */
export function isUnsizedType(palletType: string): boolean {
  return palletType === "carton" || palletType === "custom";
}

/** A cargo line as it feeds the capacity math. `estimated_pallets` is the
 *  requestor's OPTIONAL 4×4-equivalent estimate for a carton/custom line. */
export interface CargoLine {
  pallet_type: string;
  quantity: number;
  estimated_pallets?: number | null;
}

/**
 * Total 4×4-pallet-equivalent load for a set of cargo lines. Rounded to 3 dp to
 * keep the 3.125 factor exact while avoiding floating-point noise. For a
 * carton/custom line the requestor's estimate (if given) IS the line's
 * equivalent; without one the line contributes 0 (and the order counts as
 * unsized for dispatch — see isUnsizedForDispatch).
 */
export function palletEquivalents(cargo: CargoLine[]): number {
  const total = cargo.reduce((sum, c) => {
    if (isUnsizedType(c.pallet_type)) return sum + (c.estimated_pallets ?? 0);
    return sum + palletFactor(c.pallet_type) * c.quantity;
  }, 0);
  return Math.round(total * 1000) / 1000;
}

/**
 * True when the order cannot be sized for auto-dispatch: any carton/"Others"
 * (custom) line without a usable estimate. Such an order must NOT auto-dispatch
 * to the smallest truck (a 0-equivalent "fits everything") — it routes to manual
 * assignment via the needs-attention flag. Pallet lines never make an order
 * unsized (their pallet type always gives a footprint).
 */
export function isUnsizedForDispatch(cargo: CargoLine[]): boolean {
  return cargo.some(
    (c) => isUnsizedType(c.pallet_type) && !(c.estimated_pallets != null && c.estimated_pallets > 0)
  );
}
