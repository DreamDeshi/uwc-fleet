import { describe, it, expect } from "vitest";
import { bookableConsigneesWhere, createTripSchema, PICKUP_GRACE_MS } from "../src/routes/trips";
import { CARGO_PALLET_TYPES } from "../src/lib/pallets";

/**
 * Booking-creation validation: a pickup in the past is rejected at CREATE time
 * (with a small grace window for clock skew), instead of being accepted and
 * then failing dispatch forever. The oversized-cargo check (CARGO_EXCEEDS_FLEET)
 * is DB-backed in the route; its pallet math is covered by pallets.test.ts.
 */

const base = {
  route_type_id: "rt1",
  stops: [{ consignee_id: "c1" }],
  cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
};

describe("createTripSchema — pickup must not be in the past", () => {
  it("rejects a pickup an hour ago", () => {
    const r = createTripSchema.safeParse({
      ...base,
      pickup_datetime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("accepts a pickup just inside the clock-skew grace window", () => {
    const r = createTripSchema.safeParse({
      ...base,
      pickup_datetime: new Date(Date.now() - PICKUP_GRACE_MS + 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it("rejects a pickup just outside the grace window", () => {
    const r = createTripSchema.safeParse({
      ...base,
      pickup_datetime: new Date(Date.now() - PICKUP_GRACE_MS - 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("accepts a future pickup", () => {
    const r = createTripSchema.safeParse({
      ...base,
      pickup_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
  });
});

describe("createTripSchema — pallet_type is the workbook's closed vocabulary", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const withCargo = (cargo: unknown) =>
    createTripSchema.safeParse({ ...base, cargo_details: cargo, pickup_datetime: future });

  it("accepts every bookable type", () => {
    for (const t of CARGO_PALLET_TYPES) {
      expect(withCargo([{ pallet_type: t, quantity: 1 }]).success, t).toBe(true);
    }
  });

  // The regression this guards: "5x10" with an ASCII x has no known footprint,
  // so it used to convert to a guessed 1 slot instead of 3.125 — six of them
  // read as 6 slots against a real 18.75 and overloaded an 8-pallet truck.
  it("rejects a wrong-encoding ASCII size instead of silently under-counting it", () => {
    expect(withCargo([{ pallet_type: "5x10", quantity: 6 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "4x8", quantity: 1 }]).success).toBe(false);
  });

  it("rejects a footprint that is simply not in the spec", () => {
    expect(withCargo([{ pallet_type: "6×6", quantity: 1 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "banana", quantity: 1 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "", quantity: 1 }]).success).toBe(false);
  });
});

describe("bookableConsigneesWhere — inactive consignees cannot be booked", () => {
  it("filters on is_active, so a deactivated (wrong-zone) consignee fails the count check", () => {
    // The route compares found-count to requested-count; because the where
    // clause demands is_active, an inactive consignee is simply "not found"
    // and the booking 400s — stale rebook/chip references included.
    expect(bookableConsigneesWhere(["c1", "c2"])).toEqual({
      id: { in: ["c1", "c2"] },
      is_active: true,
    });
  });
});
