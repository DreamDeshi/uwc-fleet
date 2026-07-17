// Pallet → 4×4-equivalent conversion — MIRROR of api/src/lib/pallets.ts (spec
// AUTO DISPATCH LOGIC: "everything is measured in 4×4 Pallets"). The server
// validates capacity in these units, so the booking form's over-capacity
// warning must count the same way or it warns on loads that fit (16× 2×2 = 4
// slots) and stays silent on loads that don't (6× 5×10 = 18.75 slots).
// Pure module (no React Native imports) — unit-tested in pallets.test.ts.
// The bookable pallet footprints (workbook REQUESTOR INTERFACE). "×" is U+00D7,
// NOT an ASCII "x" — the server enums on these exact strings, so the booking
// form must emit them verbatim.
export const PALLET_SIZES = [
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
] as const;

/** A bookable pallet footprint. Annotating a list with this makes a typo — an
 *  ASCII "4x4" for the U+00D7 "4×4" — a compile error rather than a silent
 *  zero-footprint line at runtime. */
export type PalletSize = (typeof PALLET_SIZES)[number];

/** "carton" / "custom" (Others) carry no pallet footprint by conversion. */
export const UNSIZED_CARGO_TYPES = ["carton", "custom"] as const;

/** Every pallet_type the API accepts — mirrors api/src/lib/pallets.ts. */
export const CARGO_PALLET_TYPES = [...PALLET_SIZES, ...UNSIZED_CARGO_TYPES] as const;

/**
 * Slots per pallet, relative to a single 4×4 (= 1 slot). Keyed by PALLET_SIZES
 * so adding a size without its factor is a compile error, not a silent 0.
 * The rule is AREA ÷ 16 — see api/src/lib/pallets.ts, which this mirrors.
 */
export const PALLET_FACTORS: Record<(typeof PALLET_SIZES)[number], number> = {
  // ⚠ 1×1 / 1×2 unconfirmed as pallet types — see the server's note.
  "1×1": 0.0625, // 1 / 16
  "1×2": 0.125, // 2 / 16
  "2×2": 0.25, // 4 / 16
  "2×3": 0.375, // 6 / 16
  "3×3": 0.5625, // 9 / 16
  "3×4": 0.75, // 12 / 16
  "4×4": 1, // 16 / 16 — the reference slot
  "4×8": 2, // 32 / 16
  "5×5": 1.5625, // 25 / 16
  "5×10": 3.125, // 50 / 16
};

const FACTORS: Record<string, number> = PALLET_FACTORS;

/** 4×4-equivalent slots for one cargo line's pallet type. Anything without a
 *  known footprint converts to 0 — never to a guessed slot count. */
export function palletFactor(palletType: string): number {
  return FACTORS[palletType] ?? 0;
}

/** True for any type with no pallet footprint by conversion: carton/custom
 *  (Others) and any unrecognised type — sizeable only from the requestor's
 *  estimate, never guessed at. */
export function isUnsizedType(palletType: string): boolean {
  return !(palletType in PALLET_FACTORS);
}

export interface CargoLine {
  pallet_type: string;
  quantity: number;
  estimated_pallets?: number | null;
}

/**
 * Total 4×4-pallet-equivalent load for a set of cargo lines. Rounded to 4 dp —
 * every factor is area ÷ 16, so the finest is 1/16 = 0.0625 and 3 dp would
 * round it to 0.063. Must match the server's rounding exactly or the form's
 * warning disagrees with the server's capacity verdict. For a carton/custom
 * line the requestor's estimate (if given) IS the line's equivalent; without
 * one it contributes 0.
 */
export function palletEquivalents(cargo: CargoLine[]): number {
  const total = cargo.reduce((sum, c) => {
    if (isUnsizedType(c.pallet_type)) return sum + (c.estimated_pallets ?? 0);
    return sum + palletFactor(c.pallet_type) * c.quantity;
  }, 0);
  return Math.round(total * 10000) / 10000;
}
