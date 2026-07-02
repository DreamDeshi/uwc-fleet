import { test, expect } from "@playwright/test";
import { REQUESTOR } from "../helpers/accounts";
import { createTrip, login } from "../helpers/api";
import { pickConsignee, pickRouteType, CARGO_LINE } from "../helpers/seed";
import { resetState } from "../helpers/reset";

/**
 * BOOKING-CREATION VALIDATION (buildable-queue Q1). API-level checks against
 * the shared backend:
 *   - cargo bigger than the largest truck (16 pallets) → 400 CARGO_EXCEEDS_FLEET
 *     at CREATE, instead of booking-then-failing-dispatch-forever (this replaced
 *     the old oversized-order fixture the needs-attention specs used);
 *   - a pickup in the past → rejected at CREATE (15-min clock-skew grace).
 */
test.describe("Booking-creation validation", () => {
  test.beforeEach(async () => {
    await resetState();
  });

  test("cargo exceeding the largest truck is rejected at create (CARGO_EXCEEDS_FLEET)", async () => {
    const requestor = await login(REQUESTOR);
    const [routeType, consignee] = await Promise.all([
      pickRouteType(requestor.accessToken),
      pickConsignee(requestor.accessToken),
    ]);
    await expect(
      createTrip(requestor.accessToken, {
        route_type_id: routeType.id,
        pickup_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        stops: [{ consignee_id: consignee.id }],
        cargo_details: [{ pallet_type: "4×4", quantity: 20 }], // 20 > 16
      })
    ).rejects.toThrow(/CARGO_EXCEEDS_FLEET/);
  });

  test("a pickup in the past is rejected at create", async () => {
    const requestor = await login(REQUESTOR);
    const [routeType, consignee] = await Promise.all([
      pickRouteType(requestor.accessToken),
      pickConsignee(requestor.accessToken),
    ]);
    await expect(
      createTrip(requestor.accessToken, {
        route_type_id: routeType.id,
        pickup_datetime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago
        stops: [{ consignee_id: consignee.id }],
        cargo_details: [CARGO_LINE],
      })
    ).rejects.toThrow(/400/);
  });
});
