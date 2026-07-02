import { describe, it, expect } from "vitest";
import { createTripSchema, PICKUP_GRACE_MS } from "../src/routes/trips";

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
