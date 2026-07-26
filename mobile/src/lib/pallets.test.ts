import { describe, expect, it } from "vitest";
import {
  CARGO_PALLET_TYPES,
  BOOKABLE_CARGO_TYPES,
  BOOKABLE_PALLET_SIZES,
  DEPRECATED_PALLET_SIZES,
  PALLET_SIZES,
  PALLET_FACTORS,
  isDeprecatedPalletSize,
  partitionEditableCargo,
  finalizeCargoPayload,
  palletEquivalents,
  palletFactor,
  canonicalCargoSize,
  isValidDimension,
  isAlwaysManualType,
} from "./pallets";

// These factors MUST stay identical to api/src/lib/pallets.ts — the server
// enforces capacity in 4×4-equivalents, and the booking form warns with this
// mirror. The literals below are the spec table (master doc §11).
describe("pallet factors mirror the server", () => {
  it("matches the spec conversion table exactly", () => {
    expect(PALLET_FACTORS).toEqual({
      "1×1": 0.0625,
      "1×2": 0.125,
      "2×2": 0.25,
      "2×3": 0.375,
      "3×3": 0.5625,
      "3×4": 0.75,
      "4×4": 1,
      "4×8": 2,
      "5×5": 1.5625,
      "5×10": 3.125,
    });
  });

  it("derives every factor from area ÷ 16, exactly as the server does", () => {
    for (const [size, factor] of Object.entries(PALLET_FACTORS)) {
      const [w, h] = size.split("×").map(Number);
      expect(factor, `${size}`).toBe((w * h) / 16);
    }
  });

  it("gives cartons/custom and any unrecognised footprint no slots", () => {
    expect(palletFactor("carton")).toBe(0);
    expect(palletFactor("custom")).toBe(0);
    // Guessing one slot for an unknown is the UNSAFE direction — a 6×6 is ~2.25
    // slots and an ASCII "5x10" is really 3.125, so a guessed 1 under-counts and
    // the form would stay silent on a load that overloads the truck. The server
    // enums pallet_type, so these can't be booked at all.
    expect(palletFactor("6×6")).toBe(0);
    expect(palletFactor("5x10")).toBe(0); // ASCII "x" — not the U+00D7 key
  });

  it("keeps the full/legacy vocabulary (for historical rows) intact", () => {
    expect([...CARGO_PALLET_TYPES]).toEqual([
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
      "carton",
      "custom",
      "box",
      "crate",
      "rack",
    ]);
  });

  it("rounds to 4 dp like the server — a 3 dp mirror would disagree on 1×1", () => {
    // If the two round differently the form's warning and the server's capacity
    // verdict diverge on the new sixteenth-sized footprints.
    expect(palletEquivalents([{ pallet_type: "1×1", quantity: 1 }])).toBe(0.0625);
    expect(palletEquivalents([{ pallet_type: "5×5", quantity: 1 }])).toBe(1.5625);
  });
});

// ── Q1 (CLIENT_ANSWERS_R1_2026-07-24): 1×1/1×2 removed from bookable sizes ────
describe("Q1 — bookable vocabulary drops 1×1/1×2, mirrors the server", () => {
  it("DEPRECATED_PALLET_SIZES matches the server (ASCII and × agree)", () => {
    expect([...DEPRECATED_PALLET_SIZES]).toEqual(["1×1", "1×2"]);
    expect(isDeprecatedPalletSize("1×2")).toBe(true);
    expect(isDeprecatedPalletSize("1x1")).toBe(true); // ASCII normalises
    expect(isDeprecatedPalletSize("1 X 2")).toBe(true);
    expect(isDeprecatedPalletSize("4×4")).toBe(false);
  });

  it("BOOKABLE sizes = PALLET_SIZES minus deprecated (drift guard)", () => {
    const expected = PALLET_SIZES.filter((s) => !(DEPRECATED_PALLET_SIZES as readonly string[]).includes(s));
    expect([...BOOKABLE_PALLET_SIZES]).toEqual(expected);
  });

  it("the bookable vocabulary excludes 1×1/1×2 and includes the Q10 non-pallet types", () => {
    expect([...BOOKABLE_CARGO_TYPES]).toEqual([
      "2×2", "2×3", "3×3", "3×4", "4×4", "4×8", "5×5", "5×10", "carton", "custom", "box", "crate", "rack",
    ]);
  });
});

describe("legacy display compatibility — historical 1×1/1×2 still convert", () => {
  it("keeps the deprecated factors so an existing record renders/counts unchanged", () => {
    expect(palletFactor("1×1")).toBe(0.0625);
    expect(palletFactor("1×2")).toBe(0.125);
    expect(palletEquivalents([{ pallet_type: "1×2", quantity: 4 }])).toBe(0.5);
  });
});

// Edit-form legacy preservation (Q1 fix): the form must keep historical 1×1/1×2
// lines read-only and re-append them verbatim, never silently dropping them.
describe("partitionEditableCargo — legacy vs bookable split, round-trips", () => {
  it("splits a legacy-only booking (all lines preserved as legacy)", () => {
    const lines = [
      { pallet_type: "1×1", quantity: 3 },
      { pallet_type: "1×2", quantity: 1 },
    ];
    const { bookable, legacy } = partitionEditableCargo(lines);
    expect(bookable).toEqual([]);
    expect(legacy).toEqual(lines);
    // Round-trip: rebuilt payload (no bookable steppers set) still carries legacy.
    expect([...bookable, ...legacy]).toEqual(lines);
  });

  it("splits a MIXED booking and round-trips both current and legacy cargo", () => {
    const lines = [
      { pallet_type: "4×4", quantity: 2 },
      { pallet_type: "1×1", quantity: 3 },
      { pallet_type: "5×5", quantity: 1 },
    ];
    const { bookable, legacy } = partitionEditableCargo(lines);
    expect(bookable).toEqual([
      { pallet_type: "4×4", quantity: 2 },
      { pallet_type: "5×5", quantity: 1 },
    ]);
    expect(legacy).toEqual([{ pallet_type: "1×1", quantity: 3 }]);
    // Order-independent round-trip: every original line survives.
    expect([...bookable, ...legacy].sort((a, b) => a.pallet_type.localeCompare(b.pallet_type))).toEqual(
      [...lines].sort((a, b) => a.pallet_type.localeCompare(b.pallet_type))
    );
  });

  it("classifies an ASCII-spelled legacy line consistently with the × form", () => {
    const { bookable, legacy } = partitionEditableCargo([
      { pallet_type: "4×4", quantity: 1 },
      { pallet_type: "1x2", quantity: 2 }, // ASCII
    ]);
    expect(legacy).toEqual([{ pallet_type: "1x2", quantity: 2 }]); // preserved verbatim
    expect(bookable).toEqual([{ pallet_type: "4×4", quantity: 1 }]);
  });

  it("Q10: legacy carton + free-text custom are legacy; structured custom + box/crate/rack are bookable", () => {
    // Legacy carton and a legacy free-text custom (no dims) → read-only legacy.
    const legacyOut = partitionEditableCargo([
      { pallet_type: "carton", quantity: 5 },
      { pallet_type: "custom", quantity: 1, custom_size: "free text" },
    ]);
    expect(legacyOut.bookable).toEqual([]);
    expect(legacyOut.legacy).toHaveLength(2);

    // Box, crate/rack, and a STRUCTURED custom (with dims) → editable/bookable.
    const bookableOut = partitionEditableCargo([
      { pallet_type: "box", quantity: 3 },
      { pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 },
      { pallet_type: "custom", quantity: 1, width_ft: 6, length_ft: 2 },
    ]);
    expect(bookableOut.legacy).toEqual([]);
    expect(bookableOut.bookable).toHaveLength(3);
  });
});

// Mixed-booking deletion bug fix: EVERY cargo-type branch of buildCargo funnels
// through finalizeCargoPayload, so a carton/custom edit can no longer drop the
// preserved legacy lines that only the pallet branch used to re-append.
describe("finalizeCargoPayload — the one payload finalization every branch uses", () => {
  const legacy1x1 = [{ pallet_type: "1×1", quantity: 3 }];

  it("carton + 1×1 round-trips (legacy survives an unrelated carton edit)", () => {
    const current = [{ pallet_type: "carton", quantity: 5, cartons: 5 }];
    expect(finalizeCargoPayload(current, legacy1x1)).toEqual([
      { pallet_type: "carton", quantity: 5, cartons: 5 },
      { pallet_type: "1×1", quantity: 3 },
    ]);
  });

  it("custom/others + 1×2 round-trips (legacy survives an unrelated custom edit)", () => {
    const current = [{ pallet_type: "custom", quantity: 1, custom_size: "3x2x1 crate" }];
    const legacy1x2 = [{ pallet_type: "1×2", quantity: 2 }];
    expect(finalizeCargoPayload(current, legacy1x2)).toEqual([
      { pallet_type: "custom", quantity: 1, custom_size: "3x2x1 crate" },
      { pallet_type: "1×2", quantity: 2 },
    ]);
  });

  it("current pallet + legacy round-trips", () => {
    const current = [{ pallet_type: "4×4", quantity: 2 }];
    expect(finalizeCargoPayload(current, legacy1x1)).toEqual([
      { pallet_type: "4×4", quantity: 2 },
      { pallet_type: "1×1", quantity: 3 },
    ]);
  });

  it("legacy-only (no current lines) still emits the legacy cargo", () => {
    expect(finalizeCargoPayload([], legacy1x1)).toEqual([{ pallet_type: "1×1", quantity: 3 }]);
  });

  it("intentional legacy removal stays removed (empty legacy → no legacy lines)", () => {
    const current = [{ pallet_type: "carton", quantity: 5, cartons: 5 }];
    expect(finalizeCargoPayload(current, [])).toEqual(current);
  });

  it("a new booking (empty legacy) can never emit legacy cargo", () => {
    const current = [{ pallet_type: "4×4", quantity: 1 }];
    const out = finalizeCargoPayload(current, []);
    expect(out.some((l) => isDeprecatedPalletSize(l.pallet_type))).toBe(false);
  });

  it("appends legacy exactly ONCE — no duplication", () => {
    const current = [{ pallet_type: "4×4", quantity: 1 }];
    const out = finalizeCargoPayload(current, legacy1x1);
    expect(out.filter((l) => l.pallet_type === "1×1")).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it("rides the remark on the first line of the combined payload", () => {
    const current = [{ pallet_type: "carton", quantity: 5, cartons: 5 }];
    const out = finalizeCargoPayload(current, legacy1x1, "handle with care");
    expect(out[0].remark).toBe("handle with care");
    expect(out[1].remark).toBeUndefined(); // legacy line untouched
  });

  it("legacy-only with a remark rides it on the legacy line", () => {
    const out = finalizeCargoPayload([], legacy1x1, "fragile");
    expect(out[0]).toEqual({ pallet_type: "1×1", quantity: 3, remark: "fragile" });
  });
});

describe("Q1 — confirmed factors (5×5 / 3×3 / 2×3)", () => {
  it("matches the confirmed values", () => {
    expect(palletFactor("5×5")).toBe(1.5625);
    expect(palletFactor("3×3")).toBe(0.5625);
    expect(palletFactor("2×3")).toBe(0.375);
  });
});

describe("booking-form warning cases (audit finding 4.2)", () => {
  it("6× 5×10 is 18.75 equivalents — MUST warn (server rejects >16)", () => {
    expect(palletEquivalents([{ pallet_type: "5×10", quantity: 6 }])).toBe(18.75);
  });

  it("16× 2×2 is only 4 equivalents — must NOT warn", () => {
    expect(palletEquivalents([{ pallet_type: "2×2", quantity: 16 }])).toBe(4);
  });

  it("mixed lines sum in slots, not units", () => {
    expect(
      palletEquivalents([
        { pallet_type: "4×4", quantity: 3 },
        { pallet_type: "4×8", quantity: 2 },
        { pallet_type: "2×2", quantity: 4 },
      ])
    ).toBe(8);
  });
});

describe("Q10 — mirror of the API dimension helpers + always-manual set", () => {
  it("canonicalCargoSize renders W × L ft, trimming trailing zeros", () => {
    expect(canonicalCargoSize(4, 3)).toBe("4 × 3 ft");
    expect(canonicalCargoSize(4.5, 3)).toBe("4.5 × 3 ft");
    expect(canonicalCargoSize(4.0, 3.0)).toBe("4 × 3 ft");
  });

  it("isValidDimension rejects 0, negative, NaN and infinities", () => {
    expect(isValidDimension(4)).toBe(true);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "4", null, undefined]) {
      expect(isValidDimension(bad)).toBe(false);
    }
  });

  it("box/crate/rack/custom are always-manual; carton and pallets are not", () => {
    for (const t of ["box", "crate", "rack", "custom"]) expect(isAlwaysManualType(t)).toBe(true);
    expect(isAlwaysManualType("carton")).toBe(false);
    expect(isAlwaysManualType("4×4")).toBe(false);
  });

  it("finalizeCargoPayload preserves a legacy line VERBATIM (custom_size + dims)", () => {
    const legacy = [{ pallet_type: "custom", quantity: 1, custom_size: "irregular frame" }];
    const out = finalizeCargoPayload([{ pallet_type: "box", quantity: 3 }], legacy);
    expect(out).toEqual([
      { pallet_type: "box", quantity: 3 },
      { pallet_type: "custom", quantity: 1, custom_size: "irregular frame" },
    ]);
  });
});
