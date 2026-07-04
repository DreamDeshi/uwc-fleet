import { describe, it, expect } from "vitest";
import { bookableConsigneesWhere, createTripSchema, PICKUP_GRACE_MS } from "../src/routes/trips";

/**
 * Booking-creation validation: a pickup in the past is rejected at CREATE time
 * (with a small grace window for clock skew), instead of being accepted and
 * then failing dispatch forever. The oversized-cargo check (CARGO_EXCEEDS_FLEET)
 * is DB-backed in the route; its pallet math is covered by pallets.test.ts.
 */

const base = {
  route_type_id: "rt1",
  stops: [{ consignee_id: "c1" }],
  cargo_details: [{ pallet_type: "4x4", quantity: 1 }],
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
