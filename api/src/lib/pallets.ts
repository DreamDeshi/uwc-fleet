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
/**
 * The pallet footprints the workbook's REQUESTOR INTERFACE offers ("4x4 x qty",
 * "3x4 x qty", …). NOTE the separator is "×" (U+00D7), not an ASCII "x" — the
 * workbook prints these with an ASCII x, so anything hand-built from the spec
 * must convert. Sizes outside this list are not bookable (see CARGO_PALLET_TYPES).
 */
export const PALLET_SIZES = ["2×2", "3×4", "4×4", "4×8", "5×10"] as const;

/** A bookable pallet footprint. Annotating a list with this makes a typo — an
 *  ASCII "4x4" for the U+00D7 "4×4" — a compile error rather than a silent
 *  zero-footprint line at runtime. */
export type PalletSize = (typeof PALLET_SIZES)[number];

/**
 * Workbook REQUESTOR INTERFACE cargo types "Carton" and "Others": no pallet
 * footprint by conversion, so they need the requestor's `estimated_pallets`.
 */
export const UNSIZED_CARGO_TYPES = ["carton", "custom"] as const;

/**
 * Every `pallet_type` the API accepts — the workbook's CLOSED vocabulary. The
 * booking route enums on this, so an unrecognised footprint can never reach the
 * capacity math from a new booking (a "5x10" with an ASCII x would otherwise
 * convert to nothing and silently under-count a 3.125-slot pallet).
 */
export const CARGO_PALLET_TYPES = [...PALLET_SIZES, ...UNSIZED_CARGO_TYPES] as const;

/**
 * Canonicalise a pallet_type's SPELLING before it's checked against the enum.
 * The sizes are stored with "×" (U+00D7), but the workbook itself prints them
 * with an ASCII "x" ("5x10 x qty"), so a caller built from the spec naturally
 * sends "5x10" / "5 x 10" / "5X10". Map [xX] → × and drop whitespace so those
 * round-trip to the canonical key; carton/custom contain no x and pass through
 * untouched. This only fixes the separator — it is NOT a vocabulary remap, so a
 * genuinely unknown footprint ("6x6" → "6×6") still fails the enum and 400s.
 * Non-ASCII lookalikes (✕, Cyrillic х) are deliberately out of scope.
 */
export function normalizePalletType(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/[xX]/g, "×");
}

/** Slots per pallet, relative to a single 4×4 (= 1 slot). Keyed by PALLET_SIZES
 *  so adding a size without its factor is a compile error, not a silent 0. */
export const PALLET_FACTORS: Record<(typeof PALLET_SIZES)[number], number> = {
  "2×2": 0.25,
  "3×4": 0.75,
  "4×4": 1,
  "4×8": 2,
  "5×10": 3.125,
};

const FACTORS: Record<string, number> = PALLET_FACTORS;

/** 4×4-equivalent slots for one cargo line's pallet type. Anything without a
 *  known footprint converts to 0 — never to a guessed slot count. */
export function palletFactor(palletType: string): number {
  return FACTORS[palletType] ?? 0;
}

/**
 * True for any type with no pallet footprint by conversion: "carton"/"custom"
 * (Others), and any UNRECOGNISED type — a legacy row, or a caller that bypassed
 * the route's enum. Such a line can only be sized by the requestor's
 * `estimated_pallets`; without one the order routes to manual assignment rather
 * than being guessed at (see isUnsizedForDispatch). Guessing is what makes an
 * unknown dangerous: a wrong-encoding "5x10" counted as one slot under-counts a
 * real 3.125-slot pallet and overloads the truck.
 */
export function isUnsizedType(palletType: string): boolean {
  return !(palletType in PALLET_FACTORS);
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
 * True when the order cannot be sized for auto-dispatch: any line with no known
 * footprint — carton/"Others" (custom), or an unrecognised type — and no usable
 * estimate. Such an order must NOT auto-dispatch to the smallest truck (a
 * 0-equivalent "fits everything") — it routes to manual assignment via the
 * needs-attention flag so an admin sizes it. A line whose pallet size IS
 * recognised never makes an order unsized (its type always gives a footprint).
 */
export function isUnsizedForDispatch(cargo: CargoLine[]): boolean {
  return cargo.some(
    (c) => isUnsizedType(c.pallet_type) && !(c.estimated_pallets != null && c.estimated_pallets > 0)
  );
}
