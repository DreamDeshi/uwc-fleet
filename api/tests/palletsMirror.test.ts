import { describe, it, expect } from "vitest";
import * as apiPallets from "../src/lib/pallets";
import * as mobilePallets from "../../mobile/src/lib/pallets";

/**
 * DRIFT GUARD: api/src/lib/pallets.ts and mobile/src/lib/pallets.ts are hand-
 * maintained twins. The booking form's over-capacity warning (mobile) and the
 * server's capacity/dispatch math (api) MUST agree, or the form warns on loads
 * that fit and stays silent on loads that don't. Nothing else keeps them in sync
 * — each file's own unit tests only check its own copy against its own numbers,
 * so a one-sided edit passes both suites yet silently diverges.
 *
 * This test compares the two modules BEHAVIOURALLY on their SHARED surface: the
 * constants and pure functions both export. It deliberately ignores each side's
 * legitimate platform-only exports (api: isUnsizedForDispatch; mobile:
 * partitionEditableCargo / finalizeCargoPayload / isDimensionedType), and it does
 * NOT compare source text — comments, ordering and imports are allowed to differ.
 * If it fails, port the change to the other file until outputs match again.
 *
 * Runs in the api unit suite (CI `checks` job). mobile/src/lib/pallets.ts is a
 * pure module (no React Native imports), so importing it here is safe.
 */

// Runtime values exported by BOTH modules. Types (PalletSize, CargoLine, …) are
// compile-time only and can't be checked at runtime, so they're not listed.
const SHARED_EXPORTS = [
  "PALLET_SIZES",
  "UNSIZED_CARGO_TYPES",
  "NONPALLET_CARGO_TYPES",
  "DIMENSIONED_CARGO_TYPES",
  "ALWAYS_MANUAL_TYPES",
  "CARGO_PALLET_TYPES",
  "DEPRECATED_PALLET_SIZES",
  "BOOKABLE_PALLET_SIZES",
  "BOOKABLE_CARGO_TYPES",
  "PALLET_FACTORS",
  "isAlwaysManualType",
  "canonicalCargoSize",
  "isValidDimension",
  "isDeprecatedPalletSize",
  "normalizePalletType",
  "palletFactor",
  "isUnsizedType",
  "palletEquivalents",
] as const;

const api = apiPallets as unknown as Record<string, unknown>;
const mobile = mobilePallets as unknown as Record<string, unknown>;

// A broad type-string matrix: every bookable/legacy footprint, the non-pallet
// types, messy spellings normalizePalletType must fix, word types it must NOT
// mangle, and unknowns. Both modules must classify/convert each identically.
const TYPE_INPUTS = [
  "1×1", "1×2", "2×2", "2×3", "3×3", "3×4", "4×4", "4×8", "5×5", "5×10",
  "carton", "box", "crate", "rack", "custom",
  "5x10", "5X10", "5 x 10", "1 X 2", "2×2 ", " 4×4",
  "box", "BOX", "Crate", "6x6", "6×6", "", "unknown", "x", "1x", "x1",
];

// Dimension inputs incl. non-numbers (isValidDimension takes `unknown`).
const DIM_INPUTS: unknown[] = [
  0, 1, 2, 3, 4, 4.5, 5, 10, 0.1, 100, 3.005, 2.555, -1, -0.5,
  NaN, Infinity, -Infinity, null, undefined, "3", "4.5", {}, [], true,
];

// Cargo sets for palletEquivalents — pure pallets, mixed, estimate-sized
// carton/custom, box/crate/rack, unknown types, null/absent estimates.
const CARGO_SETS = [
  [],
  [{ pallet_type: "4×4", quantity: 1 }],
  [{ pallet_type: "5×10", quantity: 2 }, { pallet_type: "2×2", quantity: 3 }],
  [{ pallet_type: "1×1", quantity: 16 }],
  [{ pallet_type: "carton", quantity: 5, estimated_pallets: 2 }],
  [{ pallet_type: "carton", quantity: 5, estimated_pallets: null }],
  [{ pallet_type: "carton", quantity: 5 }],
  [{ pallet_type: "custom", quantity: 1, width_ft: 4, length_ft: 8 }],
  [{ pallet_type: "box", quantity: 10 }],
  [{ pallet_type: "crate", quantity: 2, width_ft: 3, length_ft: 3 }],
  [{ pallet_type: "unknown", quantity: 4 }],
  [
    { pallet_type: "4×4", quantity: 1 },
    { pallet_type: "carton", quantity: 2, estimated_pallets: 1.5 },
    { pallet_type: "box", quantity: 3 },
  ],
] as const;

describe("pallets.ts api↔mobile drift guard", () => {
  it("both modules export every shared runtime value", () => {
    for (const name of SHARED_EXPORTS) {
      expect(api[name], `api.${name} missing`).toBeDefined();
      expect(mobile[name], `mobile.${name} missing`).toBeDefined();
    }
  });

  it("shared constants are identical", () => {
    for (const name of SHARED_EXPORTS) {
      if (typeof api[name] === "function") continue;
      expect(mobile[name], `constant ${name} diverged`).toEqual(api[name]);
    }
  });

  it("type-classification + normalization agree across the input matrix", () => {
    for (const t of TYPE_INPUTS) {
      expect(mobilePallets.isAlwaysManualType(t), `isAlwaysManualType(${JSON.stringify(t)})`)
        .toBe(apiPallets.isAlwaysManualType(t));
      expect(mobilePallets.isDeprecatedPalletSize(t), `isDeprecatedPalletSize(${JSON.stringify(t)})`)
        .toBe(apiPallets.isDeprecatedPalletSize(t));
      expect(mobilePallets.isUnsizedType(t), `isUnsizedType(${JSON.stringify(t)})`)
        .toBe(apiPallets.isUnsizedType(t));
      expect(mobilePallets.palletFactor(t), `palletFactor(${JSON.stringify(t)})`)
        .toBe(apiPallets.palletFactor(t));
      expect(mobilePallets.normalizePalletType(t), `normalizePalletType(${JSON.stringify(t)})`)
        .toBe(apiPallets.normalizePalletType(t));
    }
  });

  it("isValidDimension agrees across numbers and non-numbers", () => {
    for (const x of DIM_INPUTS) {
      expect(mobilePallets.isValidDimension(x), `isValidDimension(${JSON.stringify(x)})`)
        .toBe(apiPallets.isValidDimension(x));
    }
  });

  it("canonicalCargoSize produces identical strings", () => {
    const nums = [1, 2, 3, 4, 4.5, 5, 10, 0.1, 3.005, 2.555];
    for (const w of nums) {
      for (const l of nums) {
        expect(mobilePallets.canonicalCargoSize(w, l), `canonicalCargoSize(${w}, ${l})`)
          .toBe(apiPallets.canonicalCargoSize(w, l));
      }
    }
  });

  it("palletEquivalents agrees on every cargo set", () => {
    for (const cargo of CARGO_SETS) {
      // Clone per call so neither implementation can mutate the shared fixture.
      const a = apiPallets.palletEquivalents(cargo.map((c) => ({ ...c })));
      const m = mobilePallets.palletEquivalents(cargo.map((c) => ({ ...c })));
      expect(m, `palletEquivalents(${JSON.stringify(cargo)})`).toBe(a);
    }
  });
});
