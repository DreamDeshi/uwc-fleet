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

    // With every stop settled, the trip must be able to finalize. The driver
    // has nothing left to deliver, so the admin closes it out via abort — which
    // now recognises the settled stop as EARNING, not as an unpaid cancel.
    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "all stops undeliverable" });
    expect(abort.status, JSON.stringify(abort.body)).toBe(200);

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
