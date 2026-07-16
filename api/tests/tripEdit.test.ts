import { describe, it, expect } from "vitest";
import { summarizeTripChanges, updateTripSchema, type TripEditSnapshot } from "../src/routes/trips";

/**
 * Booking-edit validation + change summary. The route-level guards (owner,
 * pending-only, CAS vs a racing assignment, changed-pickup grace) are
 * DB-backed and covered by tests-integration/tripEdit.test.ts; here we cover
 * the pure pieces: the update schema (which deliberately has NO past-pickup
 * refine — the route enforces it only when the pickup changed) and the
 * "who changed what" note builder.
 */

const existing: TripEditSnapshot = {
  route_type_id: "rt1",
  pickup_datetime: new Date("2026-07-20T02:00:00.000Z"),
  stops: [
    { sequence: 1, consignee_id: "c1" },
    { sequence: 2, consignee_id: "c2" },
  ],
  cargo_details: [
    {
      pallet_type: "4×4",
      quantity: 2,
      cartons: null,
      custom_size: null,
      estimated_pallets: null,
      remark: "fragile",
    },
  ],
};

const sameInput = {
  route_type_id: "rt1",
  pickup_datetime: new Date("2026-07-20T02:00:00.000Z"),
  stops: [
    { consignee_id: "c1", sequence: 1 },
    { consignee_id: "c2", sequence: 2 },
  ],
  cargo_details: [{ pallet_type: "4×4", quantity: 2, remark: "fragile" }],
};

describe("updateTripSchema", () => {
  it("accepts a past pickup (the route only enforces the grace window when the pickup CHANGED)", () => {
    const r = updateTripSchema.safeParse({
      ...sameInput,
      pickup_datetime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it("still requires at least one stop and one cargo line", () => {
    expect(updateTripSchema.safeParse({ ...sameInput, stops: [] }).success).toBe(false);
    expect(updateTripSchema.safeParse({ ...sameInput, cargo_details: [] }).success).toBe(false);
  });

  it("does not accept is_external (locked — outsourcing is the admin's lever)", () => {
    const r = updateTripSchema.safeParse({ ...sameInput, is_external: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("is_external" in r.data).toBe(false); // stripped, never applied
    }
  });
});

describe("summarizeTripChanges", () => {
  it("returns null when nothing changed (no-op submit → no audit row, no dispatch poke)", () => {
    expect(summarizeTripChanges(existing, sameInput)).toBeNull();
  });

  it("treats missing incoming sequence as list order (create-route parity), so same order = no change", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      stops: [{ consignee_id: "c1" }, { consignee_id: "c2" }],
    });
    expect(r).toBeNull();
  });

  it("reports a swapped consignee", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      stops: [{ consignee_id: "c1", sequence: 1 }, { consignee_id: "c9", sequence: 2 }],
    });
    expect(r).toBe("consignees");
  });

  it("reports reordered stops as a consignee change (drop order is real routing)", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      stops: [{ consignee_id: "c2", sequence: 1 }, { consignee_id: "c1", sequence: 2 }],
    });
    expect(r).toBe("consignees");
  });

  it("reports pickup and route-type changes", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      route_type_id: "rt2",
      pickup_datetime: new Date("2026-07-21T02:00:00.000Z"),
    });
    expect(r).toBe("route type; pickup time");
  });

  it("reports a quantity change as cargo", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      cargo_details: [{ pallet_type: "4×4", quantity: 3, remark: "fragile" }],
    });
    expect(r).toBe("cargo");
  });

  it("reports a remark-only change as notes, not cargo", () => {
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      cargo_details: [{ pallet_type: "4×4", quantity: 2, remark: "handle with care" }],
    });
    expect(r).toBe("notes");
  });

  it("treats absent optional cargo fields and nulls as the same value", () => {
    // Zod gives undefined for omitted optionals; the DB row holds nulls. A
    // requestor resubmitting the same line must not produce a phantom "cargo"
    // change.
    const r = summarizeTripChanges(existing, {
      ...sameInput,
      cargo_details: [
        { pallet_type: "4×4", quantity: 2, cartons: undefined, custom_size: undefined, remark: "fragile" },
      ],
    });
    expect(r).toBeNull();
  });

  it("joins multiple changes in a stable order", () => {
    const r = summarizeTripChanges(existing, {
      route_type_id: "rt2",
      pickup_datetime: new Date("2026-07-21T02:00:00.000Z"),
      stops: [{ consignee_id: "c9" }],
      cargo_details: [{ pallet_type: "2×2", quantity: 1, remark: "" }],
    });
    expect(r).toBe("route type; pickup time; consignees; cargo");
  });
});
