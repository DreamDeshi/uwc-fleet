import { describe, it, expect, beforeEach } from "vitest";
import { api, auth, resetDb, loginAs, REQUESTOR } from "./helpers/harness";
import { bookTrip, ensureConsigneeInZone, firstRouteTypeId, futurePickupIso } from "./helpers/flow";

/**
 * pallet_type is the workbook's CLOSED vocabulary (REQUESTOR INTERFACE: five
 * pallet footprints + Carton/Others), enforced by a zod enum on create AND edit.
 *
 * The regression this guards is a capacity overload, not a validation nicety.
 * The factor table keys on "×" (U+00D7) but the workbook prints the sizes with
 * an ASCII "x", so a hand-built caller naturally sends "5x10". That has no known
 * footprint: it used to convert to a guessed 1 slot instead of 3.125, so six of
 * them read as 6 slots against a real 18.75 — clearing CARGO_EXCEEDS_FLEET and
 * loading an 8-pallet truck with more than twice its capacity.
 */

const bookRaw = async (token: string, rt: string, cargo: unknown) => {
  const c = await ensureConsigneeInZone("P1");
  return api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: c.id, sequence: 1 }],
      cargo_details: cargo,
    });
};

const editRaw = (token: string, tripId: string, body: unknown) =>
  api().patch(`/api/v1/trips/${tripId}`).set(auth(token)).send(body);

describe("pallet_type vocabulary is closed (capacity safety)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects an ASCII-x size at CREATE instead of under-counting it", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    // 6× 5×10 = 18.75 equivalents — more than the 16-pallet PLX 2406. Sent with
    // an ASCII x this previously counted as 6 slots and sailed through.
    const res = await bookRaw(requestor, rt, [{ pallet_type: "5x10", quantity: 6 }]);
    expect(res.status).toBe(400);
  });

  it("still rejects the same load when correctly encoded — via the capacity guard", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    const res = await bookRaw(requestor, rt, [{ pallet_type: "5×10", quantity: 6 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CARGO_EXCEEDS_FLEET");
  });

  it("accepts every bookable type", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    for (const t of ["2×2", "3×4", "4×4", "4×8", "5×10"]) {
      const res = await bookRaw(requestor, rt, [{ pallet_type: t, quantity: 1 }]);
      expect(res.status, `${t} should be bookable`).toBe(201);
    }
    // carton/Others carry no footprint by conversion, but are valid types.
    const carton = await bookRaw(requestor, rt, [
      { pallet_type: "carton", quantity: 10, estimated_pallets: 2 },
    ]);
    expect(carton.status).toBe(201);
  });

  it("rejects an unknown footprint on the EDIT path too", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);

    const res = await editRaw(requestor, trip.id, {
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: trip.stops.map((s, i) => ({ consignee_id: s.consignee_id, sequence: i + 1 })),
      cargo_details: [{ pallet_type: "5x10", quantity: 6 }],
    });
    expect(res.status).toBe(400);
  });
});
