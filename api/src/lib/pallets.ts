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

/**
 * Non-pallet cargo types — no PALLET-TABLE footprint (factor 0 in
 * `PALLET_FACTORS`; crate/rack/custom are sized separately, see below):
 *   • carton  — LEGACY box (kept for backward compat + edit); count + optional
 *               `estimated_pallets` (its estimate may still size auto-dispatch).
 *   • box     — Q10 first-class Box: count only, NO dimensions, and NO truck
 *               space (owner ruling, 27 Aug 2026 — "the box can be put in
 *               driver seat"). Never blocks auto-dispatch and never adds to
 *               the load; see `isUnsizedForDispatch`.
 *   • crate   — Q10 first-class Crate: dimensions in feet (width_ft × length_ft)
 *               + count. SIZED as of 9 Sep 2026 (owner directive: "make the
 *               system as flexible as possible" — a bare Crate/Custom line was
 *               forcing manual assignment on an otherwise perfectly sizeable
 *               order). Extends rack's 27 Aug 2026 treatment rather than
 *               inventing a new rule: same area÷16 formula, same
 *               `dimensionedEquivalent` function, see DIMENSION_SIZED_TYPES.
 *   • rack    — Q10 first-class Rack: dimensions in feet + count, SIZED since
 *               27 Aug 2026 (owner ruling — "auto assign work with those have
 *               dimension pallet or rack"): its width_ft × length_ft converts
 *               via the same area÷16 rule as a pallet.
 *   • custom  — "Others": structured width_ft × length_ft (legacy rows may
 *               carry a free-text `custom_size` instead — those stay unsized,
 *               see the ALWAYS_MANUAL_TYPES note below); SIZED as of 9 Sep 2026
 *               when structured dims are present, same as crate/rack.
 * `UNSIZED_CARGO_TYPES` is kept (carton/custom) as the historical name some
 * callers/tests reference; the full non-pallet set is `NONPALLET_CARGO_TYPES`.
 */
export const UNSIZED_CARGO_TYPES = ["carton", "custom"] as const;
export const NONPALLET_CARGO_TYPES = ["carton", "custom", "box", "crate", "rack"] as const;

/** Q10: cargo types that carry structured dimensions (width_ft × length_ft, feet).
 *  All three now feed the capacity calculation when their dims are valid — see
 *  DIMENSION_SIZED_TYPES. */
export const DIMENSIONED_CARGO_TYPES = ["crate", "rack", "custom"] as const;

/**
 * Every DIMENSIONED_CARGO_TYPES member: width_ft × length_ft is treated as a
 * real capacity number, area ÷ 16 exactly like a pallet footprint — see
 * `dimensionedEquivalent`.
 *
 * Rack got this 27 Aug 2026 (owner ruling — "auto assign work with those have
 * dimension pallet or rack"). Crate and custom were deliberately left out at
 * the time — "a 'no authoritative capacity rule' type does not get one
 * invented for it by generalising his example" — pending an explicit
 * instruction rather than an inferred generalisation. That instruction came
 * 9 Sep 2026 ("make the system as flexible as possible", scoped to "stop
 * blocking bookings/dispatch"), so crate/custom now use the identical
 * area÷16 rule. Nothing here invents a NEW packing model — it reuses rack's
 * already-shipped one for the other two dimensioned types.
 */
export const DIMENSION_SIZED_TYPES = ["rack", "crate", "custom"] as const;

/**
 * Q10: cargo types that ALWAYS route to manual admin assignment regardless of
 * dimensions or an estimate.
 *
 * Empty as of 9 Sep 2026 — crate and custom were the last members; both are
 * now sized via DIMENSION_SIZED_TYPES when their dims are valid, exactly like
 * rack (which left this set on 27 Aug 2026 for the same reason). `box` was
 * excluded earlier still: it needs no truck space at all. `carton` was never
 * a member — its legacy estimate-sized auto-dispatch is preserved.
 *
 * A crate/custom line WITHOUT valid dims (a legacy free-text `custom_size`
 * row, or a malformed historical one — the create schema requires dims for a
 * new line) still forces manual: `dimensionedEquivalent` returns null, it
 * falls through to the `isUnsizedType` branch in `isUnsizedForDispatch`, and
 * with no `estimated_pallets` that routes to manual exactly as before. This
 * array is kept (rather than removed) as the extension point for a future
 * type that genuinely has no sizing rule at all — do not repopulate it
 * without the same kind of explicit instruction rack and crate/custom got.
 */
export const ALWAYS_MANUAL_TYPES = [] as const;
export function isAlwaysManualType(palletType: string): boolean {
  return (ALWAYS_MANUAL_TYPES as readonly string[]).includes(palletType);
}

/**
 * A dimensioned line's 4×4-equivalent, for the types in DIMENSION_SIZED_TYPES
 * (rack, crate, custom) — same AREA ÷ 16 rule as a pallet footprint, computed
 * from width_ft × length_ft rather than looked up by name. `null` when the
 * type isn't in the sized set, or its dims are missing/invalid — the caller
 * falls back to the ordinary unsized handling (never a guessed number).
 */
export function dimensionedEquivalent(c: {
  pallet_type: string;
  width_ft?: number | null;
  length_ft?: number | null;
}): number | null {
  if (!(DIMENSION_SIZED_TYPES as readonly string[]).includes(c.pallet_type)) return null;
  if (!isValidDimension(c.width_ft) || !isValidDimension(c.length_ft)) return null;
  return (c.width_ft * c.length_ft) / 16;
}

/**
 * The FULL, legacy pallet_type vocabulary — every footprint that has ever been
 * bookable, plus every non-pallet type. Retained as the compatibility surface:
 * historical CargoDetail rows may still carry a now-deprecated size (1×1 / 1×2),
 * and their factors/labels must keep resolving. NEW bookings validate on the
 * narrower BOOKABLE_CARGO_TYPES below — do not point the booking route at this list.
 */
export const CARGO_PALLET_TYPES = [...PALLET_SIZES, ...NONPALLET_CARGO_TYPES] as const;

/**
 * Canonical stored representation of a structured dimension (Q10): "W × L ft"
 * with trailing-zero-trimmed numbers (4 × 3 ft, 4.5 × 3 ft). The "×" is U+00D7.
 */
export function canonicalCargoSize(widthFt: number, lengthFt: number): string {
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  return `${fmt(widthFt)} × ${fmt(lengthFt)} ft`;
}
/** A positive, finite dimension (rejects 0, negative, NaN, ±Infinity). */
export function isValidDimension(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * DEPRECATED as bookable footprints (Q1, CLIENT_ANSWERS_R1_2026-07-24): Mr. Teh —
 * "PLEASE REMOVE 1X1 & 1X2, above dimension is for pallets only, for box,
 * requestor just indicate how many box." 1×1/1×2 are BOXES, not pallets, so they
 * are removed from NEW-booking options. Their PALLET_FACTORS entries stay (below)
 * purely so existing historical records still display and convert unchanged —
 * this list is what separates "no longer selectable" from "erased".
 */
export const DEPRECATED_PALLET_SIZES = ["1×1", "1×2"] as const;
export type DeprecatedPalletSize = (typeof DEPRECATED_PALLET_SIZES)[number];

/** True for a footprint that is no longer offered on new bookings (kept for legacy
 *  display). Normalises the separator first so "1x1" / "1 X 2" and "1×1" agree —
 *  matches mobile/src/lib/pallets.ts (locked by tests/palletsMirror.test.ts). No
 *  live api caller sends a non-canonical size, so this is a no-op on real data;
 *  it keeps the twin functions identical. */
export function isDeprecatedPalletSize(size: string): boolean {
  return (DEPRECATED_PALLET_SIZES as readonly string[]).includes(normalizePalletType(size));
}

/**
 * The pallet footprints a NEW booking may select (Q1): PALLET_SIZES minus the
 * deprecated boxes. Declared explicitly (not filtered) so it stays a literal
 * tuple for z.enum; a drift-guard test asserts it equals PALLET_SIZES −
 * DEPRECATED_PALLET_SIZES.
 */
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

/**
 * The vocabulary a NEW booking's pallet_type is validated against — bookable
 * pallet footprints + the non-pallet types. The booking route enums on THIS, so
 * 1×1/1×2 are rejected on new bookings while remaining resolvable for historical
 * rows. `carton` stays accepted for backward compatibility (the mobile UI offers
 * `box` instead); box/crate/rack/custom are the Q10 first-class additions.
 */
export const BOOKABLE_CARGO_TYPES = [...BOOKABLE_PALLET_SIZES, ...NONPALLET_CARGO_TYPES] as const;

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
  // Convert the separator ONLY between two digits ("5x10" → "5×10", "1 X 2" →
  // "1×2"). A blanket [xX] → × would mangle a word type — "box" → "bo×" — so the
  // digit-bounded rule keeps box/carton/crate/rack/custom untouched. Uses a
  // capturing group (NOT lookbehind) so it runs on the mobile's Hermes engine.
  return raw.replace(/\s+/g, "").replace(/(\d)[xX](\d)/g, "$1×$2");
}

/**
 * Slots per pallet, relative to a single 4×4 (= 1 slot). Keyed by PALLET_SIZES
 * so adding a size without its factor is a compile error, not a silent 0.
 *
 * THE RULE IS AREA ÷ 16 (a 4×4 pallet being 16 square units = 1 slot). Every
 * factor that predates this comment fits it exactly — 2×2 = 4/16 = 0.25,
 * 3×4 = 12/16 = 0.75, 4×4 = 16/16 = 1, 4×8 = 32/16 = 2, 5×10 = 50/16 = 3.125 —
 * so the sizes added for item 2 (Mr. Teh, 17 Jul 2026) are derived, not guessed.
 * A new footprint's factor is w × h / 16; write the arithmetic out below rather
 * than computing it, so a wrong entry is visible on inspection.
 */
export const PALLET_FACTORS: Record<(typeof PALLET_SIZES)[number], number> = {
  // 1×1 and 1×2 are DEPRECATED as bookable footprints (Q1, R1 2026-07-24: they
  // are boxes, not pallets — see DEPRECATED_PALLET_SIZES). Their factors are
  // KEPT so existing historical records still convert and display exactly as
  // before; new bookings can no longer select them.
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
  width_ft?: number | null;
  length_ft?: number | null;
}

/**
 * Total 4×4-pallet-equivalent load for a set of cargo lines. For a
 * carton/custom-without-dims line the requestor's estimate (if given) IS the
 * line's equivalent; without one the line contributes 0 (and the order counts
 * as unsized for dispatch — see isUnsizedForDispatch). A DIMENSION_SIZED_TYPES
 * line (rack, crate, custom-with-dims) contributes its own area÷16 equivalent,
 * exactly like a pallet — checked FIRST, so it never falls into the
 * estimate-based branch below even though all three are also (by name alone)
 * "unsized" types.
 *
 * Rounded to 4 dp, not 3. Every factor is area ÷ 16, so the finest is
 * 1/16 = 0.0625 and every reachable total is some m/16 — which needs exactly
 * four decimals. 3 dp was enough while the smallest factor was 2×2's 0.25 (and
 * the longest 5×10's 3.125), but it would round item 2's new 1×1 to 0.063 and
 * corrupt the value on the way out. 4 dp is exact for every m/16 while still
 * flattening any float noise.
 */
export function palletEquivalents(cargo: CargoLine[]): number {
  const total = cargo.reduce((sum, c) => {
    const dimEquiv = dimensionedEquivalent(c);
    if (dimEquiv != null) return sum + dimEquiv * c.quantity;
    if (isUnsizedType(c.pallet_type)) return sum + (c.estimated_pallets ?? 0);
    return sum + palletFactor(c.pallet_type) * c.quantity;
  }, 0);
  return Math.round(total * 10000) / 10000;
}

/**
 * True when the order cannot be sized for auto-dispatch: any line with no known
 * footprint — carton/"Others" (custom), or an unrecognised type — and no usable
 * estimate. Such an order must NOT auto-dispatch to the smallest truck (a
 * 0-equivalent "fits everything") — it routes to manual assignment via the
 * needs-attention flag so an admin sizes it. A line whose pallet size IS
 * recognised never makes an order unsized (its type always gives a footprint).
 *
 * Exceptions to "flag and go manual":
 *   • `box` never blocks (owner ruling, 27 Aug 2026) — it needs no truck space
 *     at all ("the box can be put in driver seat"), so its presence says
 *     nothing about whether the REST of the order is sizeable.
 *   • a DIMENSION_SIZED_TYPES line (rack, crate, custom) WITH valid dims is
 *     sized by `dimensionedEquivalent` just like a pallet, so it doesn't force
 *     manual either — rack since 27 Aug 2026, crate/custom since 9 Sep 2026.
 *
 * A dimensioned line WITHOUT valid dims (missing/invalid width_ft or
 * length_ft — the create schema requires both for a new crate/rack/custom
 * line, so this only catches a legacy/malformed row, e.g. a pre-Q10 free-text
 * custom_size) falls through to the ordinary carton/"Others" branch below:
 * unsized by name, sizeable only from `estimated_pallets` if the requestor
 * gave one, manual otherwise. `ALWAYS_MANUAL_TYPES` is checked first but is
 * currently empty — kept as the extension point for a future type with
 * genuinely no sizing rule, not for these three.
 */
export function isUnsizedForDispatch(cargo: CargoLine[]): boolean {
  return cargo.some((c) => {
    if (c.pallet_type === "box") return false;
    if (dimensionedEquivalent(c) != null) return false;
    return (
      // ALWAYS_MANUAL_TYPES is currently empty (see its own comment) — every
      // dimensioned type is sized above when its dims are valid. This stays as
      // the hook for a future type with no sizing rule at all.
      isAlwaysManualType(c.pallet_type) ||
      // A dimensioned type with missing/invalid dims (a legacy row), plus
      // legacy carton / any unrecognised type: unsized by name, so it only
      // auto-dispatches when the requestor supplied a usable estimate.
      (isUnsizedType(c.pallet_type) && !(c.estimated_pallets != null && c.estimated_pallets > 0))
    );
  });
}
