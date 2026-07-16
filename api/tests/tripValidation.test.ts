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

  // Normalisation: the workbook prints "5x10" (ASCII x); it now round-trips to
  // the canonical "5×10" and validates, rather than 400-ing the spec's own
  // spelling. It must ALSO store canonical, so downstream capacity math (which
  // keys on "×") sees a real 3.125-slot pallet, not a silently-dropped one.
  it("normalises an ASCII-x size to the canonical key and accepts it", () => {
    for (const [sent, canonical] of [
      ["5x10", "5×10"],
      ["5 x 10", "5×10"],
      ["4X8", "4×8"],
      ["2 X 2", "2×2"],
    ] as const) {
      const r = withCargo([{ pallet_type: sent, quantity: 1 }]);
      expect(r.success, sent).toBe(true);
      if (r.success) expect(r.data.cargo_details[0].pallet_type).toBe(canonical);
    }
  });

  it("still rejects a footprint that is not in the spec — even after normalising the separator", () => {
    expect(withCargo([{ pallet_type: "6x6", quantity: 1 }]).success).toBe(false); // → "6×6", not a size
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
