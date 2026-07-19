import { describe, it, expect } from "vitest";
import {
  palletsMap,
  palletQtysFor,
  upsertTemplate,
  removeTemplate,
  type BookingTemplate,
} from "./bookingTemplates";
import type { PalletSize } from "./pallets";

// A stand-in display order — deliberately NOT the lib's own order, to prove the
// map is order-independent.
const ORDER_A: PalletSize[] = ["4×4", "3×4", "5×10", "2×2"];
const ORDER_B: PalletSize[] = ["2×2", "5×10", "3×4", "4×4"];

const tpl = (over: Partial<BookingTemplate> = {}): BookingTemplate => ({
  name: "Weekly Jabil",
  routeTypeId: "rt1",
  stops: [],
  cargoType: "pallet",
  pallets: {},
  cartonQty: 0,
  othersText: "",
  sizeEstimate: "",
  remarks: "",
  ...over,
});

describe("palletsMap — form qty array → size→qty map", () => {
  it("keeps only non-zero sizes, keyed by size", () => {
    expect(palletsMap(ORDER_A, [2, 0, 1, 0])).toEqual({ "4×4": 2, "5×10": 1 });
  });

  it("returns an empty map when nothing is ordered", () => {
    expect(palletsMap(ORDER_A, [0, 0, 0, 0])).toEqual({});
  });

  it("tolerates a short qty array (missing → 0)", () => {
    expect(palletsMap(ORDER_A, [3])).toEqual({ "4×4": 3 });
  });
});

describe("palletQtysFor — map → qty array for a given display order", () => {
  it("round-trips through the SAME order", () => {
    const map = palletsMap(ORDER_A, [2, 0, 1, 0]);
    expect(palletQtysFor(tpl({ pallets: map }), ORDER_A)).toEqual([2, 0, 1, 0]);
  });

  it("survives a REORDERED display list — the whole point of keying by size", () => {
    const map = palletsMap(ORDER_A, [2, 0, 1, 0]); // { 4×4:2, 5×10:1 }
    // Same cargo, different column order → the right quantities land on the
    // right sizes, not shifted by index.
    expect(palletQtysFor(tpl({ pallets: map }), ORDER_B)).toEqual([0, 1, 0, 2]);
  });

  it("defaults every size to 0 when the template has no pallets", () => {
    expect(palletQtysFor(tpl(), ORDER_A)).toEqual([0, 0, 0, 0]);
  });
});

describe("upsertTemplate", () => {
  it("appends a new template", () => {
    const list = upsertTemplate([], tpl({ name: "A" }));
    expect(list.map((t) => t.name)).toEqual(["A"]);
  });

  it("replaces a same-named template rather than duplicating", () => {
    const list = upsertTemplate([tpl({ name: "A", remarks: "old" })], tpl({ name: "A", remarks: "new" }));
    expect(list).toHaveLength(1);
    expect(list[0].remarks).toBe("new");
  });

  it("leaves other templates untouched", () => {
    const list = upsertTemplate([tpl({ name: "A" }), tpl({ name: "B" })], tpl({ name: "A", remarks: "x" }));
    expect(list.map((t) => t.name).sort()).toEqual(["A", "B"]);
  });
});

describe("removeTemplate", () => {
  it("drops the named template", () => {
    expect(removeTemplate([tpl({ name: "A" }), tpl({ name: "B" })], "A").map((t) => t.name)).toEqual(["B"]);
  });

  it("is a no-op for an unknown name", () => {
    expect(removeTemplate([tpl({ name: "A" })], "Z").map((t) => t.name)).toEqual(["A"]);
  });
});
