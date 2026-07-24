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

/** The FULL, legacy pallet_type vocabulary — mirrors api/src/lib/pallets.ts.
 *  Retained so historical CargoDetail rows (which may carry a deprecated 1×1/1×2)
 *  still resolve. NEW bookings validate on BOOKABLE_CARGO_TYPES below. */
export const CARGO_PALLET_TYPES = [...PALLET_SIZES, ...UNSIZED_CARGO_TYPES] as const;

/** DEPRECATED as bookable footprints (Q1, R1 2026-07-24): 1×1/1×2 are boxes, not
 *  pallets, so they are removed from new-booking options. Factors below are kept
 *  ONLY so existing historical records display/convert unchanged. */
export const DEPRECATED_PALLET_SIZES = ["1×1", "1×2"] as const;

/** Canonicalise a pallet_type's SPELLING (ASCII "1x1"/"1 X 1" → "1×1") — mirrors
 *  api/src/lib/pallets.ts normalizePalletType. Separator only, not a remap. */
export function normalizePalletType(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/[xX]/g, "×");
}

/** True for a footprint no longer offered on new bookings (kept for legacy
 *  display). Normalises the separator first so "1x1" and "1×1" agree. */
export function isDeprecatedPalletSize(size: string): boolean {
  return (DEPRECATED_PALLET_SIZES as readonly string[]).includes(normalizePalletType(size));
}

/**
 * Split a booking's loaded cargo lines into the CURRENTLY-BOOKABLE lines (fed to
 * the size steppers) and the DEPRECATED "legacy" lines (1×1/1×2) that the edit
 * form must preserve read-only. Keeping them separate is what stops an edit from
 * silently dropping a legacy line: the form rebuilds bookable lines from the
 * steppers and re-appends `legacy` verbatim on save. Generic over the line shape
 * so it works with the API's cargo_details rows directly. */
export function partitionEditableCargo<T extends { pallet_type: string }>(
  lines: readonly T[]
): { bookable: T[]; legacy: T[] } {
  const bookable: T[] = [];
  const legacy: T[] = [];
  for (const line of lines) {
    (isDeprecatedPalletSize(line.pallet_type) ? legacy : bookable).push(line);
  }
  return { bookable, legacy };
}

/** One outgoing cargo line as the booking API accepts it. */
export interface OutgoingCargoLine {
  pallet_type: string;
  quantity: number;
  cartons?: number;
  custom_size?: string;
  estimated_pallets?: number;
  remark?: string;
}

/**
 * THE single finalization step every cargo-type branch of the booking form must
 * funnel through. Given the branch's CURRENT lines (pallet / carton / custom) and
 * the preserved `legacy` (deprecated 1×1/1×2) lines, it:
 *   - appends the legacy lines ONCE, after the current ones (no duplication);
 *   - rides the optional remark on the first line of the combined list.
 *
 * This is what stops a carton/custom (or any) edit from silently dropping legacy
 * cargo: the payload is only ever built here, so legacy can never be bypassed.
 * `legacy` is empty for new bookings, so a new booking can never emit legacy cargo.
 */
export function finalizeCargoPayload(
  current: OutgoingCargoLine[],
  legacy: readonly { pallet_type: string; quantity: number }[],
  remark?: string
): OutgoingCargoLine[] {
  const combined: OutgoingCargoLine[] = [...current, ...legacy.map((l) => ({ pallet_type: l.pallet_type, quantity: l.quantity }))];
  return combined.map((line, idx) => (idx === 0 && remark ? { ...line, remark } : line));
}

/** The footprints a NEW booking may select — PALLET_SIZES minus the deprecated
 *  boxes. Explicit tuple (not filtered) to keep literal types; mirrors the API. */
export const BOOKABLE_PALLET_SIZES = [
  "2×2",
  "2×3",
  "3×3",
  "3×4",
  "4×4",
  "4×8",
  "5×5",
  "5×10",
] as const;
export type BookablePalletSize = (typeof BOOKABLE_PALLET_SIZES)[number];

/** The vocabulary a NEW booking's pallet_type is validated against — bookable
 *  pallet footprints + carton/Others. Mirrors the API's booking-route enum. */
export const BOOKABLE_CARGO_TYPES = [...BOOKABLE_PALLET_SIZES, ...UNSIZED_CARGO_TYPES] as const;

/**
 * Slots per pallet, relative to a single 4×4 (= 1 slot). Keyed by PALLET_SIZES
 * so adding a size without its factor is a compile error, not a silent 0.
 * The rule is AREA ÷ 16 — see api/src/lib/pallets.ts, which this mirrors.
 */
export const PALLET_FACTORS: Record<(typeof PALLET_SIZES)[number], number> = {
  // 1×1 / 1×2 are DEPRECATED as bookable footprints (Q1, R1 2026-07-24: boxes,
  // not pallets — see DEPRECATED_PALLET_SIZES). Factors kept for legacy display.
  "1×1": 0.0625, // 1 / 16  (legacy display only)
  "1×2": 0.125, // 2 / 16  (legacy display only)
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
