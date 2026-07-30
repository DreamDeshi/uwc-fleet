import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Same Cloudinary stub as exceptionWorkflow: evidence upload must not hit the
// network, and this suite cares about MONEY, not bytes.
vi.mock("../src/lib/cloudinary", () => ({
  uploadBuffer: vi.fn(async (_buf: Buffer, folder: string) => ({
    url: `https://res.cloudinary.test/${folder}/authenticated`,
    publicId: `${folder}/pub_${randomUUID()}`,
    resourceType: "image",
    format: "jpg",
  })),
  isCloudinaryConfigured: () => true,
  cloudinary: { url: (publicId: string) => `https://res.cloudinary.test/signed/${publicId}` },
}));

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip, num } from "./helpers/flow";

/**
 * FAILED-DELIVERY PAY — R3 Q11(a), end-to-end through Postgres. MONEY PATH.
 *
 * Mr. Teh, 29 Jul 2026: "Same rate paid, although not delivered." A stop the
 * driver REACHED but could not deliver, once the admin resolves the exception,
 * earns exactly what a delivered stop earns.
 *
 * The seeded PND 1888: weekday RM11 / off-peak RM13, daily deduction 2.
 * Ipoh (A2) = 6 pts, Kulim (K1) = 3 pts, Penang (P1) = 3 pts.
 */

const PND_PLATE = "PND 1888";
const PHOTO = Buffer.from("fake-jpeg-bytes");

let requestor = "", admin = "", driver = "", driverId = "", rt = "";

function reportReq(tripId: string, stopId: string) {
  const r = api().post(`/api/v1/trips/${tripId}/exception`).set(auth(driver));
  const fields: Record<string, string> = {
    category: "customer_site",
    reason: "Gate locked, nobody to receive",
    trip_stop_id: stopId,
    client_occurrence_id: randomUUID(),
    client_action_id: randomUUID(),
    client_evidence_id: randomUUID(),
    lat: "5.28",
    lng: "100.46",
    accuracy_m: "12",
  };
  for (const [k, v] of Object.entries(fields)) r.field(k, v);
  return r.attach("photo", PHOTO, "e.jpg");
}

/** Report a stop-attached exception and close it via verify → resolve(resume). */
async function failStopAndResolve(tripId: string, stopId: string) {
  // The driver must have ARRIVED — that is the line between Q11(a) and Q11(b).
  const arrived = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
  expect(arrived.status).toBe(200);

  const reported = await reportReq(tripId, stopId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  const exId = reported.body.exception.id as string;

  const verified = await api().post(`/api/v1/trips/${tripId}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: randomUUID() });
  expect(verified.status).toBe(200);

  // `resume` has its own endpoint (the /resolve route refuses it with
  // USE_RESUME_ENDPOINT); both close the exception as `resolved`.
  const resolved = await api().post(`/api/v1/trips/${tripId}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  expect(resolved.body.exception.current_state).toBe("resolved");
  return exId;
}

/**
 * The RM a trip SHOULD hold for a given point total, computed from the figures
 * the finalization actually persisted (rate_used / deduction_applied).
 *
 * Deliberately NOT a hard-coded RM: this suite runs on the real clock, so a run
 * after 18:00 MYT rates off-peak (PND 1888: RM13, not RM11) and a hard-coded
 * RM44 anchor passes only in the morning. The POINTS are the invariant; the
 * rate is a lookup. (The hard-coded RM anchors live in the unit/conformance
 * tier, which pins the clock.)
 */
async function expectedRm(tripId: string, points: number): Promise<number> {
  const t = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  const rate = num(t.rate_used);
  const deduction = t.deduction_applied ?? 0;
  expect(rate).toBeGreaterThan(0);
  return Math.round((points - deduction) * rate * 100) / 100;
}

async function deliverStop(tripId: string, stopId: string) {
  const arrived = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
  expect([200, 400]).toContain(arrived.status); // already-arrived is fine
  await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
  const res = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "delivered", stop_id: stopId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const freshTrip = (id: string) => prisma.trip.findUniqueOrThrow({ where: { id } });

describe("failed-delivery pay (R3 Q11a) — through Postgres", () => {
  beforeAll(async () => {
    process.env.FEATURE_EXCEPTIONS = "true";
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => {
    delete process.env.FEATURE_EXCEPTIONS;
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
  });

  async function startedTrip(zones: string[]) {
    const t = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, t.id, driverId, PND_PLATE);
    await startTrip(driver, t.id);
    return t;
  }

  it("THE RULE: a single Ipoh stop that could not be delivered pays the SAME as delivered", async () => {
    // Full 6 zone points, minus the day's deduction — identical to a delivered
    // Ipoh stop (the workbook's own (6−2)×11 = RM44 worked figure at peak
    // rates). The ONLY difference from a delivered trip is that no POD exists.
    const t = await startedTrip(["A2"]);
    const stopId = t.stops[0].id;
    await failStopAndResolve(t.id, stopId);

    // ⚠ NO ABORT. Settling the LAST outstanding stop must finalize the trip on
    // its own. There is no further delivery event coming, so if closing the
    // exception did not finalize, this trip would sit in_progress forever: the
    // pay would never propose, the driver would be locked out of every other
    // trip by the one-active guard, and the truck's capacity would never free.
    // The 3am sweep deliberately never touches in_progress, so nothing else
    // would rescue it — pay would exist only if an admin happened to hit Abort,
    // which files a `cancelled` timeline event on a trip that is being paid.
    const after = await freshTrip(t.id);
    expect(after.status).toBe("pending_approval"); // the approval lane, NOT cancelled
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 6));

    // The stop itself is never marked delivered — the goods did not arrive.
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } });
    expect(stop.status).not.toBe("delivered");
    expect(stop.delivered_at).toBeNull();
    expect(stop.points_awarded).toBe(6); // but it scored
  });

  it("a stop the driver NEVER REACHED still earns nothing (Q11b)", async () => {
    // Two stops; he delivers the first and never arrives at the second, then
    // the trip is aborted. Only the delivered stop pays: (6−2)×11 = RM44.
    const t = await startedTrip(["A2", "K1"]);
    await deliverStop(t.id, t.stops[0].id);

    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "breakdown" });
    expect(abort.status).toBe(200);

    const after = await freshTrip(t.id);
    expect(after.status).toBe("pending_approval");
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 6)); // only the A2 stop; K1 contributed nothing
    const k1 = await prisma.tripStop.findUniqueOrThrow({ where: { id: t.stops[1].id } });
    expect(k1.points_awarded).toBeNull();
  });

  it("a REJECTED exception is the admin's no-pay lever", async () => {
    const t = await startedTrip(["A2"]);
    const stopId = t.stops[0].id;
    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(200);
    const reported = await reportReq(t.id, stopId);
    expect(reported.status).toBe(201);
    const exId = reported.body.exception.id as string;

    const rejected = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/reject`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "no evidence of a genuine failure" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.exception.current_state).toBe("rejected");

    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "closed out" });
    expect(abort.status).toBe(200);

    const after = await freshTrip(t.id);
    expect(after.status).toBe("cancelled"); // nothing earned → the old no-pay path
    expect(after.incentive_earned).toBeNull();
  });

  it("a settled stop does not block the trip from finalizing on a LATER delivery", async () => {
    // Stop 1 (Ipoh) fails and is resolved; stop 2 (Kulim) is delivered. The
    // delivery of the LAST outstanding stop must finalize the whole trip —
    // before this change the settled stop counted as outstanding forever.
    const t = await startedTrip(["A2", "K1"]);
    await failStopAndResolve(t.id, t.stops[0].id);
    await deliverStop(t.id, t.stops[1].id);

    const after = await freshTrip(t.id);
    expect(after.status).toBe("pending_approval"); // finalized without an abort
    // Ipoh 6 (settled) + Kulim 3 (delivered) = 9, minus the day's deduction 2
    // → 7 × 11 = RM77.
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 9)); // Ipoh 6 (settled) + Kulim 3
  });

  it("the settled stop claims its zone's first-drop slot: a later SAME-ZONE delivery is a 1-pt repeat", async () => {
    // ⚠ This is the R4 question — pinned so a change of answer is a visible
    // test change, not a silent money drift. Ipoh failed (6 pts, first drop),
    // then Ipoh delivered (repeat → 1 pt): (6 + 1 − 2) × 11 = RM55.
    const t = await startedTrip(["A2", "A2"]);
    await failStopAndResolve(t.id, t.stops[0].id);
    await deliverStop(t.id, t.stops[1].id);

    const after = await freshTrip(t.id);
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 7)); // 6 (first drop) + 1 (repeat)
    const stops = await prisma.tripStop.findMany({ where: { trip_id: t.id }, orderBy: { sequence: "asc" } });
    expect(stops[0].points_awarded).toBe(6); // the failed-but-paid first drop
    expect(stops[1].points_awarded).toBe(1); // the delivered repeat
  });

  it("the driver is FREED and the truck released once the settled trip finalizes", async () => {
    // The operational half of the blocker above: a trip stuck in_progress locks
    // its driver out of every other trip (DRIVER_ALREADY_ON_TRIP).
    const t = await startedTrip(["A2"]);
    await failStopAndResolve(t.id, t.stops[0].id);
    expect((await freshTrip(t.id)).status).toBe("pending_approval");

    const next = await bookTrip(requestor, ["K1"], rt);
    const assigned = await api()
      .patch(`/api/v1/trips/${next.id}/approve`)
      .set(auth(admin))
      .send({ driver_id: driverId, truck_plate: PND_PLATE });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
  });

  it("the RATE TIER is set by the delivery confirm, never by a failed stop's arrival", async () => {
    // ⚠ FROZEN ITEM (AGENTS.md): which timestamp selects a whole-trip rate.
    // The day-group anchor is a MINIMUM, so letting an arrival in could only
    // ever drag the tier EARLIER — off-peak into peak — and systematically
    // UNDERPAY. Worked case: Ipoh failed at 17:45, Kulim delivered at 18:20.
    // Anchoring on the arrival rates the whole group weekday RM11 (RM77);
    // anchoring on the delivery confirm rates it off-peak RM13 (RM91).
    const t = await startedTrip(["A2", "K1"]);
    await failStopAndResolve(t.id, t.stops[0].id);
    await deliverStop(t.id, t.stops[1].id);

    // Backdate to straddle 18:00 MYT, then re-finalize from scratch so the
    // engine re-runs against a pinned clock (the suite otherwise runs on the
    // real one, which is exactly how this went unnoticed).
    const arrivedAt = new Date("2026-07-29T09:45:00Z"); // 17:45 MYT — peak
    const deliveredAt = new Date("2026-07-29T10:20:00Z"); // 18:20 MYT — off-peak
    await prisma.tripStop.update({ where: { id: t.stops[0].id }, data: { arrived_at: arrivedAt } });
    await prisma.tripStop.update({ where: { id: t.stops[1].id }, data: { delivered_at: deliveredAt } });
    await prisma.trip.update({
      where: { id: t.id },
      data: { status: "in_progress", incentive_earned: null, rate_used: null, deduction_applied: null },
    });
    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "re-finalize" });
    expect(abort.status, JSON.stringify(abort.body)).toBe(200);

    const after = await freshTrip(t.id);
    // The OFF-PEAK rate, chosen by the 18:20 delivery — not the 17:45 arrival.
    expect(num(after.rate_used)).toBe(13);
    // Ipoh 6 (settled, still paid) + Kulim 3 − deduction 2 = 7 × 13 = RM91.
    expect(num(after.incentive_earned)).toBe(91);
  });

  it("an ALL-FAILED trip still gets a rate — it falls back to the arrival", async () => {
    // The one case where an arrival may set the tier: no delivery exists to
    // re-rate, so the only instant available is when he was there.
    const t = await startedTrip(["A2"]);
    await failStopAndResolve(t.id, t.stops[0].id);
    const after = await freshTrip(t.id);
    expect(num(after.rate_used)).toBeGreaterThan(0);
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 6));
  });

  // ── The two halves of the adjudication, end to end ────────────────────────

  it("a BARE RESUME (no verify) pays nothing — unblocking a truck is not a pay decision", async () => {
    // "Resume trip" is reachable straight from `reported`, and every category
    // defaults to attaching to the driver's CURRENT stop. So an admin tapping
    // Resume to get a broken-down truck moving would, under a
    // current_state-only rule, have silently paid full Ipoh points for a stop
    // nobody adjudicated. The verify action is what authorises the money.
    const t = await startedTrip(["A2"]);
    const stopId = t.stops[0].id;
    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(200);
    const reported = await reportReq(t.id, stopId);
    expect(reported.status).toBe(201);
    const exId = reported.body.exception.id as string;

    // Straight to resume — NO verify.
    const resumed = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.exception.current_state).toBe("resolved");

    // The stop is NOT settled, so it is still outstanding and the trip has not
    // finalized. Closing it out is the unpaid cancel, as before.
    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "closed out" });
    expect(abort.status).toBe(200);

    const after = await freshTrip(t.id);
    expect(after.status).toBe("cancelled");
    expect(after.incentive_earned).toBeNull();
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } });
    expect(stop.points_awarded).toBeNull();
  });

  it("RETRY settles nothing — the stop stays outstanding and the driver can still deliver it", async () => {
    // "Retry" means go back and try again. If it settled the stop, the trip
    // would finalize under the driver and his later delivery would be rejected
    // as TRIP_NOT_ACTIVE — which the mobile outbox swallows as success, so he
    // would never see that his delivery was lost.
    const t = await startedTrip(["A2"]);
    const stopId = t.stops[0].id;
    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(200);
    const reported = await reportReq(t.id, stopId);
    expect(reported.status).toBe(201);
    const exId = reported.body.exception.id as string;

    const verified = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(verified.status).toBe(200);
    const retried = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resolve`).set(auth(admin)).send({ client_action_id: randomUUID(), resolution: "retry", note: "customer will be back after lunch" });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.exception.current_state).toBe("resolved");

    // Still in progress with the stop outstanding — NOT finalized.
    const mid = await freshTrip(t.id);
    expect(mid.status).toBe("in_progress");
    expect(mid.incentive_earned).toBeNull();

    // The driver goes back and delivers. It must succeed, and pay once on the
    // normal delivered path: (6 − 2) × rate.
    await deliverStop(t.id, stopId);
    const after = await freshTrip(t.id);
    expect(after.status).toBe("pending_approval");
    expect(num(after.incentive_earned)).toBe(await expectedRm(t.id, 6));
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } });
    expect(stop.status).toBe("delivered");
    expect(stop.points_awarded).toBe(6); // once, not twice
  });

  it("an OPEN exception earns nothing yet — and still blocks the trip", async () => {
    const t = await startedTrip(["A2"]);
    const stopId = t.stops[0].id;
    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(200);
    expect((await reportReq(t.id, stopId)).status).toBe(201);

    // The open exception is the operational pause: abort is refused.
    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({});
    expect(abort.status).toBe(409);
    expect(abort.body.error.code).toBe("EXCEPTION_OPEN");
    expect((await freshTrip(t.id)).incentive_earned).toBeNull();
  });
});

describe("an explicit REJECT vetoes the stop's pay — through Postgres", () => {
  // Owner ruling, 30 Jul 2026. Unit tests pin the predicate OBJECT; only these
  // prove what Prisma actually emits for `{ some, none }` against real SQL —
  // which is the entire risk surface of the change.
  async function startedTrip(zones: string[]) {
    const t = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, t.id, driverId, PND_PLATE);
    await startTrip(driver, t.id);
    return t;
  }

  /** Report on a stop the driver has already arrived at, then REJECT it. */
  async function reportAndReject(tripId: string, stopId: string) {
    const reported = await reportReq(tripId, stopId);
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const exId = reported.body.exception.id as string;
    const rejected = await api()
      .post(`/api/v1/trips/${tripId}/exception/${exId}/reject`)
      .set(auth(admin))
      .send({ client_action_id: randomUUID(), note: "not a genuine failure" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    return exId;
  }

  it("a stop with BOTH a rejection and an approval pays NOTHING — and the trip still finalizes", async () => {
    // THE REGRESSION TEST. Putting the veto in the single shared predicate made
    // this stop OUTSTANDING again, so the trip never finalized: driver and truck
    // held, and the pay the OTHER stop earned never proposed. Two assertions,
    // because either one alone would have passed while the other was broken.
    const t = await startedTrip(["A2", "K1"]); // Ipoh 6 pts, Kulim 3 pts
    const [ipoh, kulim] = t.stops;

    // Ipoh: rejected first, then a second report verified + resumed.
    await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: ipoh.id });
    await reportAndReject(t.id, ipoh.id);
    await failStopAndResolve(t.id, ipoh.id);

    await deliverStop(t.id, kulim.id);

    // It finalized — the veto did not strand the trip.
    const trip = await freshTrip(t.id);
    expect(trip.status).toBe("pending_approval");

    // ...and it paid KULIM ONLY. Ipoh's 6 points are vetoed.
    expect(num(trip.incentive_earned)).toBe(await expectedRm(t.id, 3));

    const ipohRow = await prisma.tripStop.findUniqueOrThrow({ where: { id: ipoh.id } });
    expect(ipohRow.points_awarded).toBeNull(); // never scored
  });

  it("without the rejection the same shape pays BOTH stops", async () => {
    // The control. Isolates the veto as the cause of the difference above —
    // otherwise a stop dropping out for some unrelated reason would look identical.
    const t = await startedTrip(["A2", "K1"]);
    const [ipoh, kulim] = t.stops;
    await failStopAndResolve(t.id, ipoh.id);
    await deliverStop(t.id, kulim.id);

    const trip = await freshTrip(t.id);
    expect(trip.status).toBe("pending_approval");
    expect(num(trip.incentive_earned)).toBe(await expectedRm(t.id, 9)); // 6 + 3
  });

  it("a rejection on ANOTHER stop does not touch this one", async () => {
    // `none` must be correlated to the stop, not global. If Prisma emitted an
    // uncorrelated NOT EXISTS, one rejection anywhere would zero the whole trip.
    const t = await startedTrip(["A2", "K1"]);
    const [ipoh, kulim] = t.stops;

    await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: kulim.id });
    await reportAndReject(t.id, kulim.id); // rejection lives on KULIM
    await failStopAndResolve(t.id, ipoh.id); // approval on IPOH

    await deliverStop(t.id, kulim.id);

    const trip = await freshTrip(t.id);
    expect(trip.status).toBe("pending_approval");
    expect(num(trip.incentive_earned)).toBe(await expectedRm(t.id, 9)); // Ipoh still pays
  });

  it("a TRIP-LEVEL rejection (no stop attached) vetoes nothing", async () => {
    // The NULL trap: SQL `NOT IN (…, NULL)` is never true, so an uncorrelated
    // `none` over a nullable FK would stop EVERY undelivered stop from paying
    // the first time a trip-level report was rejected. Prisma guards it; proved.
    const t = await startedTrip(["A2"]);
    const [ipoh] = t.stops;
    await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: ipoh.id });

    const reported = await api()
      .post(`/api/v1/trips/${t.id}/exception`)
      .set(auth(driver))
      .field("category", "truck")
      .field("reason", "Breakdown, no stop attached")
      .field("client_occurrence_id", randomUUID())
      .field("client_action_id", randomUUID())
      .field("client_evidence_id", randomUUID())
      .attach("photo", PHOTO, "e.jpg");
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const tripLevelId = reported.body.exception.id as string;
    // It must genuinely have NO stop, or this proves nothing.
    expect(await prisma.tripException.findUniqueOrThrow({ where: { id: tripLevelId } })).toMatchObject({ trip_stop_id: null });

    await api().post(`/api/v1/trips/${t.id}/exception/${tripLevelId}/reject`)
      .set(auth(admin)).send({ client_action_id: randomUUID(), note: "not real" });

    await failStopAndResolve(t.id, ipoh.id);

    const trip = await freshTrip(t.id);
    expect(trip.status).toBe("pending_approval");
    expect(num(trip.incentive_earned)).toBe(await expectedRm(t.id, 6)); // Ipoh pays in full
  });
});
