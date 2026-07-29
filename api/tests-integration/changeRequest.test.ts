import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
    process.env.FEATURE_CHANGE_REQUESTS = "true";
  });
  afterEach(() => {
    delete process.env.FEATURE_CHANGE_REQUESTS;
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
    // Same MYT day, later time — a day move is refused while a lorry is
    // assigned (see the PICKUP_DAY_CHANGED test).
    const newPickup = new Date(new Date(t.pickup_datetime).getTime() + 45 * 60_000);
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


  it("MONEY: a pickup-TIME change does NOT re-price an untouched stop", async () => {
    // THE regression the money-reviewer found. Approve replaces the stop rows
    // wholesale, and re-snapshotting all of them re-priced drops the requestor
    // never touched — against TODAY's rates and TODAY's consignee zones. That
    // breaks "running trips keep the old rate" (3 Jul). Measured: a staged
    // 6 -> 9 point edit turned RM44 into RM77; a consignee zone correction
    // turned RM44 into RM11 for a driver still driving to Ipoh.
    const t = await assignedTrip(["A2"]);
    const locked = await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } });
    expect(locked.zone_points).toBe(await zonePoints("A2"));

    // The world moves under the assignment, both ways at once.
    await prisma.destinationRate.updateMany({ where: { zone_code: "A2" }, data: { points: locked.zone_points! + 3 } });
    const consigneeId = locked.consignee_id;
    await prisma.consignee.update({ where: { id: consigneeId }, data: { zone_code: "K1" } });

    try {
      // A change to the PICKUP TIME only — same day, same destination.
      const newPickup = new Date(t.pickup_datetime);
      newPickup.setUTCMinutes(newPickup.getUTCMinutes() + 30);
      const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: newPickup.toISOString() }))).body.change_request;
      const ok = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const after = await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } });
      expect(after.zone_code).toBe(locked.zone_code); // identity lock survived
      expect(after.zone_points).toBe(locked.zone_points); // and so did the points
    } finally {
      await prisma.consignee.update({ where: { id: consigneeId }, data: { zone_code: "A2" } });
      await prisma.destinationRate.updateMany({ where: { zone_code: "A2" }, data: { points: locked.zone_points! } });
    }
  });

  it("refuses a change that moves the booking to a DIFFERENT DAY", async () => {
    // The assign path validates a date against that day's truck capacity,
    // roadworthiness, the scheduling-conflict buffer and driver leave. This
    // route re-runs none of them, so a day move must go back through assignment.
    const t = await assignedTrip();
    const nextDay = new Date(t.pickup_datetime);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, { pickup_datetime: nextDay.toISOString() }))).body.change_request;

    const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(approve.body.error.code).toBe("PICKUP_DAY_CHANGED");
    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe("pending");
  });

  it("the overload guard counts the lorry's OTHER load that day", async () => {
    // A bare max_pallets compare let an approval push 27 pallet-equivalents
    // onto a 14-pallet lorry. Capacity is what is LEFT after the truck's other
    // committed load — the same maths the manual assign uses.
    const truck = await prisma.truck.findUniqueOrThrow({ where: { plate: PND_PLATE } });
    const t = await assignedTrip();
    // A second booking on the SAME truck and day, taking most of the capacity.
    const other = await bookTrip(requestor, ["K1"], rt);
    await prisma.cargoDetail.updateMany({ where: { trip_id: other.id }, data: { pallet_type: "4×4", quantity: truck.max_pallets - 1 } });
    await prisma.trip.update({
      where: { id: other.id },
      data: { status: "assigned", truck_plate: PND_PLATE, pickup_datetime: t.pickup_datetime },
    });

    // Fits the truck outright, but NOT alongside the other booking.
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
      cargo_details: [{ pallet_type: "4×4", quantity: 2 }],
    }))).body.change_request;
    const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(approve.body.error.code).toBe("TRUCK_OVERLOADED");
    expect(approve.body.error.message).toMatch(/already carries/i);
  });

  it("refuses a STALE proposal rather than reverting a later edit", async () => {
    // A proposal is a full-document overwrite. Without a staleness check:
    // submit → admin unassigns → requestor edits the cargo directly → trip
    // re-assigned → admin approves the old proposal and silently REVERTS the
    // requestor's own later edit, with nothing on screen saying so.
    const t = await assignedTrip();
    const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
      pickup_datetime: new Date(new Date(t.pickup_datetime).getTime() + 30 * 60_000).toISOString(),
    }))).body.change_request;

    // The booking moves underneath the proposal.
    await prisma.cargoDetail.updateMany({ where: { trip_id: t.id }, data: { quantity: 7 } });

    const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(approve.body.error.code).toBe("CHANGE_REQUEST_STALE");
    // The later edit stands.
    expect((await prisma.cargoDetail.findFirstOrThrow({ where: { trip_id: t.id } })).quantity).toBe(7);
  });

  it("the queue carries VALUES, not just field names", async () => {
    // "consignees" alone hides Ipoh (6 pts) -> Juru & Perai (1 pt), which is a
    // weekday drop going from RM44 to RM0. An approval gate with no visible
    // before/after is a rubber stamp.
    const t = await assignedTrip(["A2"]);
    await requestChange(requestor, t.id, await payloadFor(t.id, {
      stops: [{ consignee_id: await consigneeIn("K1"), sequence: 1 }],
    }));

    const queue = await api().get("/api/v1/trips/change-requests/open").set(auth(admin));
    const row = queue.body.change_requests[0];
    expect(Array.isArray(row.detail)).toBe(true);
    expect(row.detail.join(" ")).toMatch(/Stops:/);
    expect(row.detail.join(" ")).toMatch(/\(A2\)/); // the zone it was
    expect(row.detail.join(" ")).toMatch(/\(K1\)/); // the zone it becomes
  });


  it("is INVISIBLE while the feature flag is off", async () => {
    // Unlike the rest of this batch, Request Change changes REQUESTOR behaviour
    // the moment it deploys — so it ships dark. 404, not 403: while off it
    // should not exist, same discipline as the exception router.
    const t = await assignedTrip();
    const body = await payloadFor(t.id, { pickup_datetime: new Date(new Date(t.pickup_datetime).getTime() + 30 * 60_000).toISOString() });
    delete process.env.FEATURE_CHANGE_REQUESTS;

    expect((await requestChange(requestor, t.id, body)).status).toBe(404);
    expect((await api().get("/api/v1/trips/change-requests/open").set(auth(admin))).status).toBe(404);
    expect((await api().post(`/api/v1/trips/${t.id}/change-request/x/approve`).set(auth(admin)).send({})).status).toBe(404);
    expect((await api().post(`/api/v1/trips/${t.id}/change-request/x/reject`).set(auth(admin)).send({ note: "n" })).status).toBe(404);
  });

  it("MONEY: a NEWLY ADDED destination is priced at the trip's ASSIGNMENT era", async () => {
    // Owner ruling, 29 Jul 2026: consistency WITHIN a trip beats matching a
    // fresh assignment. Otherwise one approval leaves a trip carrying two stops
    // priced from two different rate eras and nothing explains why.
    //
    // Discriminating setup: the trip was assigned YESTERDAY, and a staged K1
    // points edit takes effect TODAY. Assignment era => the old points; approval
    // era => the new ones. (A staged edit is the only thing an era can change —
    // effectiveZonePoints gates on pending_points + its MYT effective day.)
    const t = await assignedTrip(["A2"]);
    const k1Before = await zonePoints("K1");
    // MYT is UTC+8, so "24h ago" can still be the SAME MYT day as the effective
    // date — push the assignment clearly clear of it. The effective key is the
    // MYT day of now, which is what the rates editor writes.
    const assignedAt = new Date(Date.now() - 3 * 864e5);
    const todayKey = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

    await prisma.tripStatusHistory.updateMany({
      where: { trip_id: t.id, event: "assigned" },
      data: { created_at: assignedAt },
    });
    await prisma.destinationRate.updateMany({
      where: { zone_code: "K1" },
      data: { pending_points: k1Before + 5, pending_points_effective: todayKey },
    });

    try {
      const cr = (await requestChange(requestor, t.id, await payloadFor(t.id, {
        stops: [{ consignee_id: await consigneeIn("K1"), sequence: 1 }],
      }))).body.change_request;
      const ok = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      const after = await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } });
      expect(after.zone_code).toBe("K1");
      // The staged edit matures TODAY, but this trip was assigned days ago — so
      // the new stop joins its siblings' era, not today's.
      expect(after.zone_points).toBe(k1Before);
    } finally {
      await prisma.destinationRate.updateMany({
        where: { zone_code: "K1" },
        data: { pending_points: null, pending_points_effective: null },
      });
    }
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

    let approveStatus = 0;
    try {
      const approve = await api().post(`/api/v1/trips/${t.id}/change-request/${cr.id}/approve`).set(auth(admin)).send({});
      approveStatus = approve.status;
    } finally {
      // resetDb() only truncates TRANSACTIONAL tables, so a deactivated
      // consignee would leak into every later integration file sharing this DB.
      await prisma.consignee.update({ where: { id: target }, data: { is_active: true } });
    }
    expect(approveStatus).toBe(400);
    // Still pending, trip untouched.
    expect((await prisma.tripChangeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe("pending");
    expect((await prisma.tripStop.findFirstOrThrow({ where: { trip_id: t.id } })).zone_code).toBe("A2");
  });
});
