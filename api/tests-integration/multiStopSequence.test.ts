import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, futurePickupIso, ensureConsigneeInZone } from "./helpers/flow";

/**
 * MULTI-STOP ORDER, THROUGH THE REAL API.
 *
 * `sequence` was an unvalidated client input — `z.number().int().min(1)
 * .optional()`, no cross-stop check — and it is read by three things that each
 * assume a clean 1..N:
 *
 *   - dispatchEngine's `primaryZone` = stops[0] of an `orderBy: sequence` read.
 *     That zone locks an A1/A2 run to PND 1888, and the truck sets the rate per
 *     point. A tie hands that decision to Postgres row order.
 *   - The POD upload's Cloudinary asset id, `${ticket}-stop-${sequence}`. A
 *     shared sequence is a shared asset id, so the second POD OVERWRITES the
 *     first — on the photo that gates delivery and settles approval disputes.
 *   - Every stop rail and the trip timeline.
 *
 * The requestor app has never sent a sequence, which is why nothing has broken.
 * The contract is the API, not one client.
 */
describe("multi-stop sequences are normalised on write", () => {
  let requestor = "", rt = "";

  beforeAll(async () => {
    requestor = await loginAs(REQUESTOR);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  /** Book with EXPLICIT per-stop sequences (what the app never sends). */
  async function book(stops: { zone: string; sequence?: number }[]) {
    const consignees = await Promise.all(stops.map((s) => ensureConsigneeInZone(s.zone)));
    const res = await api()
      .post("/api/v1/trips")
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: consignees.map((c, i) => ({
          consignee_id: c.id,
          ...(stops[i].sequence !== undefined ? { sequence: stops[i].sequence } : {}),
        })),
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
    expect(res.status, res.text).toBe(201);
    return { tripId: res.body.id as string, consignees };
  }

  const storedStops = (tripId: string) =>
    prisma.tripStop.findMany({
      where: { trip_id: tripId },
      orderBy: { sequence: "asc" },
      select: { sequence: true, consignee: { select: { zone_code: true } } },
    });

  it("two stops sent at sequence 1 are stored 1 and 2", async () => {
    const { tripId } = await book([
      { zone: "A2", sequence: 1 },
      { zone: "P2", sequence: 1 },
    ]);
    const stops = await storedStops(tripId);
    expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    // Unique, so the POD asset ids cannot collide.
    expect(new Set(stops.map((s) => s.sequence)).size).toBe(2);
    // And the first stop — the one that picks the truck — is the one the client
    // listed first, not whichever row came back first.
    expect(stops[0].consignee.zone_code).toBe("A2");
  });

  it("a gapped order is honoured and closed up", async () => {
    const { tripId } = await book([
      { zone: "A2", sequence: 9 },
      { zone: "K1", sequence: 3 },
      { zone: "P2", sequence: 6 },
    ]);
    const stops = await storedStops(tripId);
    expect(stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(stops.map((s) => s.consignee.zone_code)).toEqual(["K1", "P2", "A2"]);
  });

  it("the ordinary booking — no sequences at all — is unchanged", async () => {
    // The requestor app's payload. This must behave exactly as before.
    const { tripId } = await book([{ zone: "A2" }, { zone: "K1" }, { zone: "P2" }]);
    const stops = await storedStops(tripId);
    expect(stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(stops.map((s) => s.consignee.zone_code)).toEqual(["A2", "K1", "P2"]);
  });

  it("an EDIT cannot smuggle a duplicate sequence in either", async () => {
    const { tripId } = await book([{ zone: "A2" }, { zone: "P2" }]);
    const [a1, k1] = await Promise.all([ensureConsigneeInZone("A1"), ensureConsigneeInZone("K1")]);

    const res = await api()
      .patch(`/api/v1/trips/${tripId}`)
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [
          { consignee_id: a1.id, sequence: 2 },
          { consignee_id: k1.id, sequence: 2 },
        ],
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
    expect(res.status, res.text).toBe(200);

    const stops = await storedStops(tripId);
    expect(stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(stops.map((s) => s.consignee.zone_code)).toEqual(["A1", "K1"]);
  });
});
