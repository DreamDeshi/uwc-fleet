import { describe, it, expect } from "vitest";
import { createTripSchema } from "../src/routes/trips";

/**
 * DG-T7 — booking idempotency key.
 *
 * The failure this closes: POST /trips had no request key, the mobile client
 * times out at 15s and re-arms Submit in a `finally`, so a submit that timed
 * out but actually COMMITTED could be sent again — creating a duplicate
 * booking which, in `auto` dispatch mode, immediately claims a SECOND TRUCK.
 *
 * These pin the wire contract. The end-to-end behaviour (same key → one trip,
 * per-requestor scoping, unkeyed bookings still allowed) is DB-backed and
 * lives in tests-integration/bookingIdempotency.test.ts.
 */

const base = {
  route_type_id: "rt1",
  pickup_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  stops: [{ consignee_id: "c1" }],
  cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
};

describe("createTripSchema — client_request_id", () => {
  it("accepts a booking WITHOUT a key — an older client must keep working", () => {
    // Backward compatibility is the reason the column is nullable: a client
    // that never sends a key books exactly as it always did (undeduplicated).
    const r = createTripSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.client_request_id).toBeUndefined();
  });

  it("accepts and preserves a key verbatim", () => {
    const key = "9f1c2f5e-8a3d-4b7c-9e10-2b6d4a8c1e77";
    const r = createTripSchema.safeParse({ ...base, client_request_id: key });
    expect(r.success).toBe(true);
    // Compared only for equality server-side, so it must survive untouched.
    if (r.success) expect(r.data.client_request_id).toBe(key);
  });

  it("rejects an empty or too-short key rather than storing a useless one", () => {
    // "" would otherwise be a single shared key across every booking a
    // requestor makes — collapsing all of them onto the first trip.
    expect(createTripSchema.safeParse({ ...base, client_request_id: "" }).success).toBe(false);
    expect(createTripSchema.safeParse({ ...base, client_request_id: "abc" }).success).toBe(false);
  });

  it("rejects an oversized key — it is indexed, so it must stay bounded", () => {
    expect(
      createTripSchema.safeParse({ ...base, client_request_id: "x".repeat(129) }).success
    ).toBe(false);
    expect(
      createTripSchema.safeParse({ ...base, client_request_id: "x".repeat(128) }).success
    ).toBe(true);
  });

  it("accepts any opaque string of a sane length, not just a UUID", () => {
    // Deliberately not UUID-validated: the server only ever compares it, and a
    // stricter rule would reject a perfectly good key from a future client.
    expect(
      createTripSchema.safeParse({ ...base, client_request_id: "booking-2026-07-26-001" }).success
    ).toBe(true);
  });
});
