import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip } from "./helpers/flow";

/**
 * REQUEST CHANGE — Mr. Teh's A19 matrix (29 Jul 2026, DOCUMENT tier).
 *
 * > "once a lorry is assigned, the requestor should not be able to directly
 * >  change information that affects auto-dispatch... Instead, the requestor
 * >  can click 'Request Change', and the system sends the change to the
 * >  dispatcher/admin for approval."
 *
 * The money-critical property is the LAST test: approving a destination change
 * must RE-SNAPSHOT the stop's zone points. They are written at assignment, and
 * finalization scores against the snapshot — so without it the driver is paid
 * for a town he no longer visits.
 */

const PND_PLATE = "PND 1888";

let requestor = "", admin = "", driver = "", driverId = "", rt = "";

/** Zone codes → their seeded destination points, read from the DB. */
async function zonePoints(zone: string): Promise<number> {
  const r = await prisma.destinationRate.findFirstOrThrow({ where: { zone_code: zone } });
  return r.points;
}
async function consigneeIn(zone: string, notId?: string): Promise<string> {
  const c = await prisma.consignee.findFirstOrThrow({
    where: { zone_code: zone, is_active: true, ...(notId ? { id: { not: notId } } : {}) },
  });
  return c.id;
}

/** The full edit payload the change-request route accepts (same as PATCH). */
async function payloadFor(tripId: string, over: Record<string, unknown> = {}) {
  const t = await prisma.trip.findUniqueOrThrow({
    where: { id: tripId },
    include: { stops: { orderBy: { sequence: "asc" } }, cargo_details: true },
  });
  return {
    route_type_id: t.route_type_id,
    pickup_datetime: t.pickup_datetime.toISOString(),
    stops: t.stops.map((s, i) => ({ consignee_id: s.consignee_id, sequence: i + 1 })),
    cargo_details: t.cargo_details.map((c) => ({ pallet_type: c.pallet_type, quantity: c.quantity })),
    ...over,
  };
}

const requestChange = (token: string, tripId: string, body: unknown) =>
  api().post(`/api/v1/trips/${tripId}/change-request`).set(auth(token)).send(body);

describe("Request Change — assigned bookings go through admin approval", () => {
  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function assignedTrip(zones = ["A2"]) {
    const t = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, t.id, driverId, PND_PLATE);
    return t;
  }

  it("a PENDING booking is edited directly, not through the queue", async () => {
    // Routing a booking the requestor still owns outright through an approval
    // queue would be strictly worse for them, and is not what he asked for.
    const t = await bookTrip(requestor, ["A2"], rt);
    const res = await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: new Date(Date.now() + 864e5).toISOString() }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATUS");
    expect(res.body.error.message).toMatch(/edit it directly/i);
  });

  it("an ASSIGNED booking accepts a request, and the admin queue shows it", async () => {
    const t = await assignedTrip();
    const newPickup = new Date(Date.now() + 3 * 864e5);
    const res = await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: newPickup.toISOString() }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.change_request.status).toBe("pending");
    expect(res.body.change_request.summary).toMatch(/pickup/i);

    // Nothing on the trip moved — it is a PROPOSAL.
    const unchanged = await prisma.trip.findUniqueOrThrow({ where: { id: t.id } });
    expect(unchanged.pickup_datetime.getTime()).not.toBe(newPickup.getTime());

    const queue = await api().get("/api/v1/trips/change-requests/open").set(auth(admin));
    expect(queue.status).toBe(200);
    expect(queue.body.change_requests).toHaveLength(1);
    expect(queue.body.change_requests[0].ticket_number).toBe(t.ticket_number);
    expect(queue.body.change_requests[0].truck_plate).toBe(PND_PLATE);
  });

  it("a newer request SUPERSEDES an undecided older one", async () => {
    // Two pending rows could otherwise both be approved, into conflicting
    // bookings. The DB partial unique index is the hard guarantee.
    const t = await assignedTrip();
    const first = await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: new Date(Date.now() + 2 * 864e5).toISOString() }));
    expect(first.status).toBe(201);
    const second = await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: new Date(Date.now() + 4 * 864e5).toISOString() }));
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: first.body.change_request.id } })).status).toBe("superseded");
    expect(await prisma.tripChangeRequest.count({ where: { trip_id: t.id, status: "pending" } })).toBe(1);
  });

  it("refuses a no-op, a non-owner, and a trip already in transit", async () => {
    const t = await assignedTrip();
    const noop = await requestChange(requestor, t.id, await payloadFor(t.id));
    expect(noop.status).toBe(400);
    expect(noop.body.error.code).toBe("NO_CHANGES");

    expect((await requestChange(driver, t.id, await payloadFor(t.id))).status).toBe(403);

    await startTrip(driver, t.id);
    const running = await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: new Date(Date.now() + 864e5).toISOString() }));
    expect(running.status).toBe(409);
    expect(running.body.error.message).toMatch(/no longer be changed/i);
  });

  it("reject requires a note, and decides the request once", async () => {
    const t = await assignedTrip();
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: new Date(Date.now() + 2 * 864e5).toISOString() }))).body.change_request;

    const noNote = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/reject`).set(auth(admin)).send({});
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.code).toBe("NOTE_REQUIRED");

    const rejected = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/reject`).set(auth(admin)).send({ note: "lorry already loaded" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.change_request.status).toBe("rejected");
    expect(rejected.body.change_request.decision_note).toBe("lorry already loaded");

    // Deciding twice is refused — the queue cannot double-act.
    const again = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/reject`).set(auth(admin)).send({ note: "again" });
    expect(again.status).toBe(409);
  });

  it("approve REFUSES when the assigned lorry no longer fits (owner ruling: never swap silently)", async () => {
    const t = await assignedTrip();
    const truck = await prisma.truck.findUniqueOrThrow({ where: { plate: PND_PLATE } });
    // Well past the truck's capacity but within the fleet's largest, so the
    // request is legitimately submittable and only the ASSIGNED lorry fails.
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
      cargo_details: [{ pallet_type: "4×4", quantity: truck.max_pallets + 1 }],
    }))).body.change_request;
    expect(cr).toBeDefined();

    const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(approve.body.error.code).toBe("TRUCK_OVERLOADED");
    expect(approve.body.error.message).toMatch(/unassign the lorry first/i);

    // Still pending and still applicable — the admin frees the lorry, not us.
    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe("pending");
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: t.id } })).truck_plate).toBe(PND_PLATE);
  });

  it("approve applies the change once — a second approve is refused", async () => {
    const t = await assignedTrip();
    const newPickup = new Date(Date.now() + 5 * 864e5);
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: newPickup.toISOString() }))).body.change_request;

    const ok = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(new Date(ok.body.pickup_datetime).getTime()).toBe(newPickup.getTime());
    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe("approved");

    const twice = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(twice.status).toBe(409);

    // Audited + on the timeline, so a pay dispute can be traced.
    expect(await prisma.auditLog.count({ where: { record_id: t.id, action: { startsWith: "trip.change_request_approved" } } })).toBe(1);
    expect(await prisma.tripStatusHistory.count({ where: { trip_id: t.id, event: "edited" } })).toBe(1);
  });

  it("MONEY: approving a destination change RE-SNAPSHOTS the stop's zone points", async () => {
    // TripStop.zone_points is written at ASSIGNMENT and finalization scores
    // against the snapshot, not against the consignee's current zone. The stops
    // are deleted and recreated here, so without the re-snapshot the new rows
    // carry NO zone evidence at all — verified by removing the call: this test
    // then fails with "expected null to be K1".
    //
    // The client rule this upholds: the ZONE supplies the POINTS, the TRUCK
    // supplies the RM-per-point RATE, and rates lock at assignment. So the
    // points must move with the destination while the rate must not.
    const t = await assignedTrip(["A2"]); // Ipoh
    const before = await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } });
    const ipohPoints = await zonePoints("A2");
    const kulimPoints = await zonePoints("K1");
    expect(before.zone_points).toBe(ipohPoints);
    expect(ipohPoints).not.toBe(kulimPoints); // the test is meaningless otherwise

    const rateBefore = await prisma.trip.findUniqueOrThrow({ where: { id: t.id } });

    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
      stops: [{ consignee_id: await consigneeIn("K1"), sequence: 1 }],
    }))).body.change_request;
    const ok = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const after = await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } });
    expect(after.zone_code).toBe("K1");
    expect(after.zone_points).toBe(kulimPoints); // POINTS followed the destination

    // ...and the TRUCK's locked rate did NOT move — a change does not re-price
    // the lorry (rates lock at assignment, client rule 3 Jul).
    const rateAfter = await prisma.trip.findUniqueOrThrow({ where: { id: t.id } });
    expect(String(rateAfter.entitled_claim_weekday)).toBe(String(rateBefore.entitled_claim_weekday));
    expect(String(rateAfter.entitled_claim_offpeak)).toBe(String(rateBefore.entitled_claim_offpeak));
    expect(rateAfter.daily_deduction_points).toBe(rateBefore.daily_deduction_points);
  });

  it("approve RE-VALIDATES: a consignee deactivated after submission is caught", async () => {
    // A stored payload is untrusted input — it may have been written before the
    // world changed. Better a loud refusal than a booking to a dead consignee.
    const t = await assignedTrip(["A2"]);
    const target = await consigneeIn("K1");
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
      stops: [{ consignee_id: target, sequence: 1 }],
    }))).body.change_request;

    await prisma.consignee.update({ where: { id: target }, data: { is_active: false } });

    const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(approve.status).toBe(400);
    // Still pending, trip untouched.
    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe("pending");
    expect((await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } })).zone_code).toBe("A2");
  });
});
