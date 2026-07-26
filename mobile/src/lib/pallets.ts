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

/** Non-pallet cargo types (factor 0). Mirrors api/src/lib/pallets.ts:
 *  carton (legacy box), box (Q10 count-only), crate/rack/custom (Q10 dimensioned).
 *  carton/custom kept under UNSIZED_CARGO_TYPES for the historical name. */
export const UNSIZED_CARGO_TYPES = ["carton", "custom"] as const;
export const NONPALLET_CARGO_TYPES = ["carton", "custom", "box", "crate", "rack"] as const;

/** Q10: cargo types carrying structured dimensions (width_ft × length_ft, feet). */
export const DIMENSIONED_CARGO_TYPES = ["crate", "rack", "custom"] as const;

/** Q10: cargo types that ALWAYS route to manual admin assignment — box has no
 *  dimensions; crate/rack/custom have no authoritative auto-dispatch rule. carton
 *  is excluded (legacy estimate-sized dispatch preserved). Mirrors the API. */
export const ALWAYS_MANUAL_TYPES = ["box", "crate", "rack", "custom"] as const;
export function isAlwaysManualType(palletType: string): boolean {
  return (ALWAYS_MANUAL_TYPES as readonly string[]).includes(palletType);
}
export function isDimensionedType(palletType: string): boolean {
  return (DIMENSIONED_CARGO_TYPES as readonly string[]).includes(palletType);
}

/** Canonical stored representation of a structured dimension (Q10): "W × L ft"
 *  with trailing-zero-trimmed numbers. Mirrors the API. */
export function canonicalCargoSize(widthFt: number, lengthFt: number): string {
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  return `${fmt(widthFt)} × ${fmt(lengthFt)} ft`;
}
/** A positive finite dimension (rejects 0, negative, NaN, ±Infinity). */
export function isValidDimension(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The FULL, legacy pallet_type vocabulary — mirrors api/src/lib/pallets.ts.
 *  Retained so historical CargoDetail rows (which may carry a deprecated 1×1/1×2)
 *  still resolve. NEW bookings validate on BOOKABLE_CARGO_TYPES below. */
export const CARGO_PALLET_TYPES = [...PALLET_SIZES, ...NONPALLET_CARGO_TYPES] as const;

/** DEPRECATED as bookable footprints (Q1, R1 2026-07-24): 1×1/1×2 are boxes, not
 *  pallets, so they are removed from new-booking options. Factors below are kept
 *  ONLY so existing historical records display/convert unchanged. */
export const DEPRECATED_PALLET_SIZES = ["1×1", "1×2"] as const;

/** Canonicalise a pallet_type's SPELLING (ASCII "1x1"/"1 X 1" → "1×1") — mirrors
 *  api/src/lib/pallets.ts normalizePalletType. Separator only, not a remap. */
export function normalizePalletType(raw: string): string {
  // Convert the separator ONLY between two digits ("5x10" → "5×10") so a word
  // type ("box") is not mangled to "bo×". Capturing group (NOT lookbehind) so it
  // runs on Hermes. Mirrors api/src/lib/pallets.ts.
  return raw.replace(/\s+/g, "").replace(/(\d)[xX](\d)/g, "$1×$2");
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
export function partitionEditableCargo<
  T extends { pallet_type: string; width_ft?: number | null; length_ft?: number | null }
>(lines: readonly T[]): { bookable: T[]; legacy: T[] } {
  const bookable: T[] = [];
  const legacy: T[] = [];
  for (const line of lines) {
    // Legacy (read-only, preserved verbatim on save): deprecated 1×1/1×2, the
    // legacy `carton` box, and a legacy `custom` row that carries a free-text
    // size but NO structured dimensions (the new form can only edit structured
    // custom). Everything else — pallets, box, crate/rack, structured custom — is
    // editable through the steppers/dimension inputs.
    const isLegacyNonPallet =
      line.pallet_type === "carton" ||
      (line.pallet_type === "custom" && !(isValidDimension(line.width_ft) && isValidDimension(line.length_ft)));
    (isDeprecatedPalletSize(line.pallet_type) || isLegacyNonPallet ? legacy : bookable).push(line);
  }
  return { bookable, legacy };
}

/** One outgoing cargo line as the booking API accepts it. */
export interface OutgoingCargoLine {
  pallet_type: string;
  quantity: number;
  cartons?: number;
  custom_size?: string;
  width_ft?: number;
  length_ft?: number;
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
  legacy: readonly OutgoingCargoLine[],
  remark?: string
): OutgoingCargoLine[] {
  // Preserve legacy lines VERBATIM (every field — quantity, custom_size, dims,
  // cartons, estimate) so an unrelated edit never rewrites a legacy record.
  const combined: OutgoingCargoLine[] = [...current, ...legacy.map((l) => ({ ...l }))];
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
 *  pallet footprints + the non-pallet types. Mirrors the API's booking-route enum. */
export const BOOKABLE_CARGO_TYPES = [...BOOKABLE_PALLET_SIZES, ...NONPALLET_CARGO_TYPES] as const;

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
  width_ft?: number | null;
  length_ft?: number | null;
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
