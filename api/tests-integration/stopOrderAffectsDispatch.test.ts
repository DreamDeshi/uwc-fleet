import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, futurePickupIso, ensureConsigneeInZone, autoDispatch } from "./helpers/flow";

/**
 * STOP ORDER IS DISPATCH-AFFECTING — and it is not on Mr. Teh's A19 list.
 *
 * His A19 answer (29 Jul 2026) names what a requestor must not change once a
 * lorry is assigned: "Delivery location / Delivery date/time / Pallet quantity /
 * Pallet size / Priority / Customer". Stop ORDER is absent.
 *
 * It belongs there by his own criterion — "information that affects
 * auto-dispatch" — and this file is the proof, so the claim cannot rot into an
 * unverified comment. The SAME two consignees, the SAME cargo, the SAME pickup
 * time, in the opposite order, get a DIFFERENT LORRY:
 *
 *   dispatchEngine.primaryZone = stops[0] of an `orderBy: sequence` read
 *   filterA1A2Eligible locks an A1/A2 order to PND 1888
 *   the truck sets the RM-per-point rate the trip eventually pays
 *
 * So this is money, reached through a field nobody would think to protect.
 *
 * WHY IT MATTERS BEYOND THE CURIOSITY: the unbuilt half of A19 is a
 * DIRECT-EDIT path for "non-critical details" on an assigned booking. Anyone
 * building it must not derive the non-critical set by subtracting his six names
 * from updateTripSchema — that subtraction hands back `sequence`. This test is
 * what turns that into a failure instead of an assumption.
 */
describe("stop order changes the dispatch decision (A19 gap)", () => {
  let requestor = "", admin = "", rt = "";

  beforeAll(async () => {
    [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  /** Book two stops in the given zone order; one small pallet so several trucks fit. */
  async function bookInOrder(zones: [string, string]): Promise<string> {
    const consignees = await Promise.all(zones.map((z) => ensureConsigneeInZone(z)));
    const res = await api()
      .post("/api/v1/trips")
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: consignees.map((c, i) => ({ consignee_id: c.id, sequence: i + 1 })),
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  }

  async function dispatchedPlate(tripId: string): Promise<string | null> {
    const res = await autoDispatch(admin, tripId);
    expect(res.status, res.text).toBe(200);
    const t = await prisma.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: { truck_plate: true },
    });
    return t.truck_plate;
  }

  it("A2 first locks the A1/A2 primary; P2 first does not", async () => {
    // Ipoh (A2) leading → filterA1A2Eligible narrows to the primary.
    const ipohFirst = await dispatchedPlate(await bookInOrder(["A2", "P2"]));
    expect(ipohFirst, "an A2-led order should take the A1/A2 primary").toBe("PND 1888");

    // Same two destinations, same cargo, same day — reversed.
    const juruFirst = await dispatchedPlate(await bookInOrder(["P2", "A2"]));

    expect(
      juruFirst,
      [
        "",
        "Reordering the stops did NOT change the lorry.",
        "",
        "If dispatch has stopped keying on the first stop's zone this test is",
        "obsolete — but so is the A19 warning in lib/stopSequence, and the",
        "non-critical direct-edit path may now safely include `sequence`.",
        "Check primaryZone/filterA1A2Eligible before deleting this.",
        "",
      ].join("\n")
    ).not.toBe(ipohFirst);
  });

  it("the requestor cannot reach this at all once a lorry is assigned", async () => {
    // The reason the gap is currently harmless: there is no direct-edit path on
    // an ASSIGNED booking, so `sequence` can only move through Request Change,
    // where an admin sees it. That is what the A19 deviation buys.
    const tripId = await bookInOrder(["A2", "P2"]);
    await dispatchedPlate(tripId);

    const res = await api()
      .patch(`/api/v1/trips/${tripId}`)
      .set(auth(requestor))
      .send({
        route_type_id: rt,
        pickup_datetime: futurePickupIso(),
        stops: [{ consignee_id: (await ensureConsigneeInZone("P2")).id, sequence: 1 }],
        cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
      });
    // 400, not 409 — the edit route and the change-request route return
    // different HTTP codes for the same class of refusal. Asserted as it is
    // rather than as it "should" be: clients read the CODE, and changing the
    // status now would break them for a tidiness that buys nothing.
    expect(res.status, `a requestor edited an ASSIGNED booking directly: ${res.text}`).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");
    expect(res.body.error.message).toContain("not been assigned yet");
  });
});
