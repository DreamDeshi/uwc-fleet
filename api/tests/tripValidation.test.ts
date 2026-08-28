import { describe, it, expect } from "vitest";
import {
  assertMultiPickupPlantsValid,
  bookableConsigneesWhere,
  createTripSchema,
  PICKUP_GRACE_MS,
} from "../src/routes/trips";
import { ApiError } from "../src/lib/apiError";
import { BOOKABLE_CARGO_TYPES } from "../src/lib/pallets";

function expectApiError(fn: () => void, code: string) {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

/**
 * Item 3 multi-pickup — PICKUP side only. A destination-plant rule was tried
 * here too (Mr. Teh's R1 answer says interplant delivery is also restricted
 * to UWC Plant 1-9) and REMOVED: it broke interplantDispatch.test.ts,
 * interplantRoundTrip.test.ts and bookingCutoff.test.ts, which book
 * "Inter-Plant Delivery" trips to ordinary consignees and are the existing,
 * shipped money/dispatch behaviour. See the header comment on
 * assertMultiPickupPlantsValid in src/routes/trips.ts for the full account —
 * this is a genuine conflict between a written answer and how the system was
 * actually built, left unresolved rather than guessed at.
 */
describe("assertMultiPickupPlantsValid (Item 3 multi-pickup, pickup side)", () => {
  const plant = (id: string) => ({ id, is_uwc_plant: true });
  const customer = (id: string) => ({ id, is_uwc_plant: false });

  it("allows a non-interplant booking with no pickup selected (today's behaviour)", () => {
    expect(() =>
      assertMultiPickupPlantsValid({
        isInterplant: false,
        pickupConsigneeIds: [],
        foundPickupConsignees: [],
      })
    ).not.toThrow();
  });

  it("rejects setting a pickup plant on a non-interplant booking", () => {
    expectApiError(
      () =>
        assertMultiPickupPlantsValid({
          isInterplant: false,
          pickupConsigneeIds: ["p1"],
          foundPickupConsignees: [plant("p1")],
        }),
      "MULTI_PICKUP_INTERPLANT_ONLY"
    );
  });

  it("allows an interplant booking with a valid pickup plant", () => {
    expect(() =>
      assertMultiPickupPlantsValid({
        isInterplant: true,
        pickupConsigneeIds: ["p1"],
        foundPickupConsignees: [plant("p1")],
      })
    ).not.toThrow();
  });

  it("allows an interplant booking with NO pickup selected (today's single-origin default)", () => {
    expect(() =>
      assertMultiPickupPlantsValid({
        isInterplant: true,
        pickupConsigneeIds: [],
        foundPickupConsignees: [],
      })
    ).not.toThrow();
  });

  it("rejects a pickup consignee that does not exist / is inactive", () => {
    expectApiError(
      () =>
        assertMultiPickupPlantsValid({
          isInterplant: true,
          pickupConsigneeIds: ["p1", "p-ghost"],
          foundPickupConsignees: [plant("p1")], // p-ghost missing
        }),
      "PICKUP_NOT_FOUND"
    );
  });

  it("rejects a pickup that resolves to a real consignee that is NOT a UWC plant", () => {
    expectApiError(
      () =>
        assertMultiPickupPlantsValid({
          isInterplant: true,
          pickupConsigneeIds: ["cust1"],
          foundPickupConsignees: [customer("cust1")],
        }),
      "PICKUP_NOT_A_PLANT"
    );
  });
});

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
