import { describe, it, expect } from "vitest";
import { bookableConsigneesWhere, createTripSchema, PICKUP_GRACE_MS } from "../src/routes/trips";
import { BOOKABLE_CARGO_TYPES } from "../src/lib/pallets";

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

  it("accepts every bookable type (crate/rack/custom carry structured dimensions)", () => {
    const DIMENSIONED = new Set(["crate", "rack", "custom"]);
    for (const t of BOOKABLE_CARGO_TYPES) {
      const line = DIMENSIONED.has(t)
        ? { pallet_type: t, quantity: 1, width_ft: 4, length_ft: 3 }
        : { pallet_type: t, quantity: 1 };
      expect(withCargo([line]).success, t).toBe(true);
    }
  });

  it("Q10: Box has no dimensions; Crate/Rack/Custom require positive finite width_ft × length_ft", () => {
    // Box rejects dimensions.
    expect(withCargo([{ pallet_type: "box", quantity: 2, width_ft: 4, length_ft: 3 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "box", quantity: 2 }]).success).toBe(true);
    // Crate/Rack/Custom require both dims.
    for (const t of ["crate", "rack", "custom"]) {
      expect(withCargo([{ pallet_type: t, quantity: 1 }]).success, `${t} no dims`).toBe(false);
      expect(withCargo([{ pallet_type: t, quantity: 1, width_ft: 4 }]).success, `${t} half dims`).toBe(false);
      expect(withCargo([{ pallet_type: t, quantity: 1, width_ft: 4, length_ft: 3 }]).success, `${t} ok`).toBe(true);
    }
    // Malformed dimensions are rejected: zero, negative (NaN/Infinity can't ride in JSON).
    expect(withCargo([{ pallet_type: "crate", quantity: 1, width_ft: 0, length_ft: 3 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "crate", quantity: 1, width_ft: -2, length_ft: 3 }]).success).toBe(false);
    // NEW custom must be structured — a free-text custom_size is NOT enough.
    expect(withCargo([{ pallet_type: "custom", quantity: 1, custom_size: "big box" }]).success).toBe(false);
  });

  // Q1 (CLIENT_ANSWERS_R1_2026-07-24): 1×1/1×2 are boxes, not pallets, and are
  // removed from new bookings. The route must reject them so backend agrees with
  // the frontend selector — historical rows keep converting via PALLET_FACTORS.
  it("rejects the deprecated 1×1 / 1×2 footprints on a NEW booking", () => {
    expect(withCargo([{ pallet_type: "1×1", quantity: 1 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "1×2", quantity: 1 }]).success).toBe(false);
    // …including via the ASCII spelling a caller might send.
    expect(withCargo([{ pallet_type: "1x1", quantity: 1 }]).success).toBe(false);
    expect(withCargo([{ pallet_type: "1 x 2", quantity: 1 }]).success).toBe(false);
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
