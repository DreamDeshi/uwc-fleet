import { describe, it, expect } from "vitest";
import { flattenTripPages, tripsTotal } from "./tripPages";

const page = (ids: string[], total = 99) => ({
  items: ids.map((id) => ({ id })),
  total,
});

describe("flattenTripPages", () => {
  it("flattens loaded pages in order", () => {
    const flat = flattenTripPages([page(["a", "b"]), page(["c", "d"])]);
    expect(flat.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is empty while nothing is loaded", () => {
    expect(flattenTripPages(undefined)).toEqual([]);
    expect(flattenTripPages([])).toEqual([]);
  });

  it("drops a duplicated id, keeping the first (newest-page) copy", () => {
    const p1 = { items: [{ id: "a", v: 1 }, { id: "b", v: 1 }] };
    const p2 = { items: [{ id: "b", v: 2 }, { id: "c", v: 2 }] };
    const flat = flattenTripPages([p1, p2]);
    expect(flat.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(flat[1].v).toBe(1); // page 1 (the polled live head) wins
  });
});

describe("tripsTotal", () => {
  it("reads the first page's total", () => {
    expect(tripsTotal([page(["a"], 42), page(["b"], 41)], 2)).toBe(42);
  });

  it("never reports fewer than the rows actually loaded", () => {
    expect(tripsTotal([page(["a", "b"], 1)], 2)).toBe(2);
  });

  it("falls back to the loaded count before the first page lands", () => {
    expect(tripsTotal(undefined, 0)).toBe(0);
  });
});
