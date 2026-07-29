import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Cloudinary is not configured in the test env. Mock the module so uploads and
// signed-URL generation are deterministic and hit no network — the workflow
// under test cares that evidence is STORED + SEPARATE from POD, not how the
// bytes reach Cloudinary (same shortcut the POD flow helper takes).
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

import bcrypt from "bcrypt";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip } from "./helpers/flow";
import { uploadBuffer } from "../src/lib/cloudinary"; // the mocked adapter (vi.fn) — asserted for contract
import { armBarrier } from "../src/lib/testHooks"; // deterministic interleaving for concurrency tests

const PND_PLATE = "PND 1888";
const PHOTO = Buffer.from("fake-jpeg-bytes");

// Cached once in beforeAll — the general rate limiter is one budget per IP for
// the whole in-process app, so we log in ONCE (resetDb does not wipe users, so
// the tokens stay valid across tests) rather than on every test.
let requestor = "";
let requestor2 = ""; // a DIFFERENT requestor — for the non-owner read test
let admin = "";
let driver = "";
let driverId = "";
let rt = "";
const REQUESTOR2_PHONE = "+60199990002";

/** Book zones → assign PLX → start. Leaves the trip in_progress. */
async function inProgressTripZones(zones: string[]) {
  const t = await bookTrip(requestor, zones, rt);
  await approveTrip(admin, t.id, driverId, PND_PLATE);
  await startTrip(driver, t.id);
  return t;
}
function inProgressTrip() {
  return inProgressTripZones(["A2"]);
}
/** Arrive a stop and stub its POD so it is deliverable (no Cloudinary). */
async function arriveAndReadyPod(tripId: string, stopId: string) {
  const r = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
  expect(r.status).toBe(200);
  await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
}
const patchTrip = (token: string, tripId: string, body: Record<string, unknown>) =>
  api().patch(`/api/v1/trips/${tripId}/status`).set(auth(token)).send(body);
// Supertest requests are LAZY (they don't send until .then/await). `fire` kicks a
// request off immediately and returns a real Promise, so a barrier test can pause
// it mid-flight (holding a DB lock) and then start a second request.
const fire = <T>(req: PromiseLike<T>): Promise<T> => Promise.resolve(req);

function reportReq(driver: string, tripId: string, over: Record<string, string> = {}) {
  const r = api().post(`/api/v1/trips/${tripId}/exception`).set(auth(driver));
  const fields: Record<string, string> = {
    category: "customer_site",
    reason: "Gate locked, nobody to receive",
    client_occurrence_id: randomUUID(),
    client_action_id: randomUUID(),
    client_evidence_id: randomUUID(),
    lat: "5.28",
    lng: "100.46",
    accuracy_m: "12",
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) r.field(k, v);
  return r;
}

describe("exception workflow — end-to-end through Postgres", () => {
  beforeAll(async () => {
    process.env.FEATURE_EXCEPTIONS = "true";
    // A second active requestor who owns NO trips here — for the non-owner read.
    await prisma.user.upsert({
      where: { phone: REQUESTOR2_PHONE },
      update: { status: "active" },
      create: {
        phone: REQUESTOR2_PHONE,
        password_hash: await bcrypt.hash("Password123", 10),
        name: "Other Requestor",
        role: "requestor",
        status: "active",
      },
    });
    [requestor, requestor2, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs({ phone: REQUESTOR2_PHONE, password: "Password123" }),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
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

  it("feature flag OFF → routes 404 (invisible)", async () => {
    process.env.FEATURE_EXCEPTIONS = "";
    const t = await inProgressTrip();
    const res = await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    expect(res.status).toBe(404);
    process.env.FEATURE_EXCEPTIONS = "true";
  });

  it("driver reports an exception: open, evidence stored, trip STAYS in_progress", async () => {
    const t = await inProgressTrip();

    const res = await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    expect(res.status).toBe(201);
    const exc = res.body.exception;
    expect(exc.current_state).toBe("reported");
    expect(exc.is_open).toBe(true);
    expect(exc.category).toBe("customer_site");
    expect(exc.evidence).toHaveLength(1);
    expect(exc.evidence[0].url).toContain("res.cloudinary.test/signed/uwc/exceptions"); // separate folder + signed
    expect(exc.actions).toHaveLength(1);
    expect(exc.actions[0].type).toBe("report");
    expect(exc.actions[0].lat).toBeCloseTo(5.28, 2); // GPS provenance captured

    // Trip status is UNCHANGED — derived exception, capacity untouched (H1).
    const trip = (await prisma.trip.findUnique({ where: { id: t.id } }))!;
    expect(trip.status).toBe("in_progress");
    expect(trip.open_exception_id).toBe(exc.id);
    // Money path untouched.
    expect(trip.incentive_earned).toBeNull();
    expect(trip.incentive_final).toBeNull();
  });

  it("report requires a photo (mandatory evidence) → 400", async () => {
    const t = await inProgressTrip();

    const res = await reportReq(driver, t.id); // no .attach
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EVIDENCE_REQUIRED");
  });

  it("idempotent replay: identical report (same op ids + photo) returns the same row, no duplicate", async () => {
    const t = await inProgressTrip();

    // A TRUE replay reuses ALL operation ids (occurrence, action, evidence) and
    // the same photo bytes — anything else is a payload change (tested below).
    const ids = { client_occurrence_id: randomUUID(), client_action_id: randomUUID(), client_evidence_id: randomUUID() };
    const first = await reportReq(driver, t.id, ids).attach("photo", PHOTO, "e.jpg");
    expect(first.status).toBe(201);
    const second = await reportReq(driver, t.id, ids).attach("photo", PHOTO, "e.jpg");
    expect(second.status).toBe(200);
    expect(second.body.exception.id).toBe(first.body.exception.id);
    expect(await prisma.tripException.count({ where: { trip_id: t.id } })).toBe(1);
  });

  it("one open exception per trip: a second (different) report → 409", async () => {
    const t = await inProgressTrip();

    await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    const dup = await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EXCEPTION_ALREADY_OPEN");
  });

  it("a requestor cannot report → 403", async () => {
    const t = await inProgressTrip();
    const res = await reportReq(requestor, t.id).attach("photo", PHOTO, "e.jpg");
    expect(res.status).toBe(403);
  });

  it("admin verify → retry: resolved + closed, trip STAYS in_progress, pointer cleared", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const verified = await api()
      .post(`/api/v1/trips/${t.id}/exception/${exId}/verify`)
      .set(auth(admin))
      .send({ client_action_id: randomUUID() });
    expect(verified.status).toBe(200);
    expect(verified.body.exception.current_state).toBe("verified");

    const resolved = await api()
      .post(`/api/v1/trips/${t.id}/exception/${exId}/resolve`)
      .set(auth(admin))
      .send({ client_action_id: randomUUID(), resolution: "retry" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.exception.current_state).toBe("resolved");
    expect(resolved.body.exception.resolution).toBe("retry");
    expect(resolved.body.exception.is_open).toBe(false);

    const trip = (await prisma.trip.findUnique({ where: { id: t.id } }))!;
    expect(trip.status).toBe("in_progress"); // capacity/pay untouched
    expect(trip.open_exception_id).toBeNull(); // pointer released
  });

  it("resolve with a frozen-boundary resolution (reschedule) → 400, exception stays open", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const res = await api()
      .post(`/api/v1/trips/${t.id}/exception/${exId}/resolve`)
      .set(auth(admin))
      .send({ client_action_id: randomUUID(), resolution: "reschedule" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("RESOLUTION_NOT_AVAILABLE");
    expect((await prisma.tripException.findUnique({ where: { id: exId } }))!.closed_at).toBeNull();
  });

  it("reject requires a note; with one → rejected + closed", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const noNote = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/reject`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.code).toBe("NOTE_REQUIRED");

    const rejected = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/reject`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "evidence does not show a locked gate" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.exception.current_state).toBe("rejected");
    expect((await prisma.trip.findUnique({ where: { id: t.id } }))!.open_exception_id).toBeNull();
  });

  it("request-more-evidence → driver resubmits → back to reported, 2 evidence rows", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const more = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/request-more-evidence`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "please show the shopfront" });
    expect(more.status).toBe(200);
    expect(more.body.exception.current_state).toBe("more_evidence");

    const add = await api()
      .post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`)
      .set(auth(driver))
      .field("client_evidence_id", randomUUID())
      .attach("photo", PHOTO, "e2.jpg");
    expect(add.status).toBe(201);
    expect(add.body.exception.current_state).toBe("reported"); // re-review
    expect(add.body.exception.evidence).toHaveLength(2); // append-only, no overwrite
  });

  it("admin resume (CAN CONTINUE) → resolved(resume), closed, trip in_progress; driver cannot resume", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    // Owner decision: only admins close/resolve — a driver resume is forbidden.
    const asDriver = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(driver)).send({ client_action_id: randomUUID() });
    expect(asDriver.status).toBe(403);

    const resumed = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(resumed.status).toBe(200);
    expect(resumed.body.exception.resolution).toBe("resume");
    expect(resumed.body.exception.is_open).toBe(false);
    expect((await prisma.trip.findUnique({ where: { id: t.id } }))!.status).toBe("in_progress");
  });

  it("optimistic concurrency: a stale expected_version → 409", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const res = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: randomUUID(), expected_version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("idempotent action replay: same client_action_id verify twice → one action", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const cid = randomUUID();
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: cid });
    const again = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: cid });
    expect(again.status).toBe(200);
    // report + one verify (the replay is a no-op).
    expect(await prisma.exceptionAction.count({ where: { exception_id: exId } })).toBe(2);
  });

  it("requestor GET is REDACTED (no evidence media, notes or GPS); driver GET is full", async () => {
    const t = await inProgressTrip();
    await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");

    const asReq = await api().get(`/api/v1/trips/${t.id}/exception`).set(auth(requestor));
    expect(asReq.status).toBe(200);
    const rexc = asReq.body.exception;
    expect(rexc.category).toBe("customer_site");
    expect(rexc.status).toBe("open");
    expect(rexc.evidence).toBeUndefined(); // redacted
    expect(rexc.actions).toBeUndefined();
    expect(rexc.reason).toBeUndefined();

    const asDriver = await api().get(`/api/v1/trips/${t.id}/exception`).set(auth(driver));
    expect(asDriver.body.exception.evidence).toHaveLength(1);
    expect(asDriver.body.exception.actions[0].lat).toBeCloseTo(5.28, 2);
  });

  // ── Hardening: concurrency / payload idempotency / lifecycle isolation / authz ──

  it("simultaneous reports (different occurrence ids): exactly one opens", async () => {
    const t = await inProgressTrip();
    const [a, b] = await Promise.all([
      reportReq(driver, t.id).attach("photo", PHOTO, "a.jpg"),
      reportReq(driver, t.id).attach("photo", PHOTO, "b.jpg"),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.error.code).toBe("EXCEPTION_ALREADY_OPEN");
    expect(await prisma.tripException.count({ where: { trip_id: t.id, closed_at: null } })).toBe(1);
  });

  it("same-operation concurrent replay: both return the ONE committed row", async () => {
    const t = await inProgressTrip();
    const occ = randomUUID(), act = randomUUID(), ev = randomUUID();
    const mk = () => reportReq(driver, t.id, { client_occurrence_id: occ, client_action_id: act, client_evidence_id: ev }).attach("photo", PHOTO, "x.jpg");
    const [a, b] = await Promise.all([mk(), mk()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.exception.id).toBe(b.body.exception.id);
    expect(await prisma.tripException.count({ where: { trip_id: t.id } })).toBe(1);
  });

  it("operation UUID reused with a DIFFERENT payload → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const t = await inProgressTrip();
    const occ = randomUUID();
    await reportReq(driver, t.id, { client_occurrence_id: occ, reason: "first reason" }).attach("photo", PHOTO, "x.jpg");
    const reused = await reportReq(driver, t.id, { client_occurrence_id: occ, reason: "different reason" }).attach("photo", PHOTO, "x.jpg");
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("two admin actions on the SAME version: one wins, the other 409", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const verify = (cid: string) => api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: cid, expected_version: 0 });
    const [a, b] = await Promise.all([verify(randomUUID()), verify(randomUUID())]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.exceptionAction.count({ where: { exception_id: exId, type: "verify" } })).toBe(1);
  });

  it("evidence resubmission racing reject: exactly one lands, state stays consistent", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/request-more-evidence`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "more" });
    const addEv = api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", randomUUID()).attach("photo", PHOTO, "e2.jpg");
    const reject = api().post(`/api/v1/trips/${t.id}/exception/${exId}/reject`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "no good" });
    const [ev, rj] = await Promise.all([addEv, reject]);
    expect([ev.status, rj.status]).toContain(409); // one lost the version CAS
    const fresh = (await prisma.tripException.findUnique({ where: { id: exId } }))!;
    // closed_at is set iff the reject won.
    if (rj.status < 400) expect(fresh.closed_at).not.toBeNull();
    else expect(fresh.closed_at).toBeNull();
  });

  it("lifecycle isolation: Arrived, Delivered and abort are BLOCKED while an exception is open", async () => {
    const t = await inProgressTrip();
    const stopId = t.stops[0].id;
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(409); expect(arrived.body.error.code).toBe("EXCEPTION_OPEN");
    const delivered = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "delivered", stop_id: stopId });
    expect(delivered.status).toBe(409); expect(delivered.body.error.code).toBe("EXCEPTION_OPEN");
    const aborted = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({});
    expect(aborted.status).toBe(409); expect(aborted.body.error.code).toBe("EXCEPTION_OPEN");

    const trip = (await prisma.trip.findUnique({ where: { id: t.id }, include: { stops: true } }))!;
    expect(trip.status).toBe("in_progress"); // no capacity release
    expect(trip.stops[0].status).toBe("pending"); // no delivery
    expect(trip.incentive_earned).toBeNull(); // no incentive proposal

    // After the admin resumes (closes the exception), ordinary flow resumes.
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    const arrivedNow = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrivedNow.status).toBe(200);
  });

  it("wrong driver cannot replay a report; NO aggregate is exposed before authz", async () => {
    const t = await inProgressTrip();
    const occ = randomUUID();
    await reportReq(driver, t.id, { client_occurrence_id: occ }).attach("photo", PHOTO, "e.jpg");
    const otherDriver = await loginAs({ phone: "+60100000102", password: "Password123" }); // PND, not assigned here
    const replay = await reportReq(otherDriver, t.id, { client_occurrence_id: occ }).attach("photo", PHOTO, "e.jpg");
    expect(replay.status).toBe(403);
    expect(replay.body.exception).toBeUndefined();
    const resubmit = await api().post(`/api/v1/trips/${t.id}/exception/xxx/evidence`).set(auth(otherDriver)).field("client_evidence_id", randomUUID()).attach("photo", PHOTO, "e.jpg");
    expect(resubmit.status).toBe(403);
  });

  it("unauthorized roles: requestor cannot verify; driver cannot resolve", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const reqVerify = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(requestor)).send({ client_action_id: randomUUID() });
    expect(reqVerify.status).toBe(403);
    const drvResolve = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resolve`).set(auth(driver)).send({ client_action_id: randomUUID(), resolution: "retry" });
    expect(drvResolve.status).toBe(403);
  });

  it("non-owner requestor cannot read another requestor's exception → 403", async () => {
    const t = await inProgressTrip();
    await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    const res = await api().get(`/api/v1/trips/${t.id}/exception`).set(auth(requestor2));
    expect(res.status).toBe(403);
  });

  it("operation IDs must be UUIDs; geo must be in range", async () => {
    const t = await inProgressTrip();
    const badId = await reportReq(driver, t.id, { client_occurrence_id: "not-a-uuid" }).attach("photo", PHOTO, "e.jpg");
    expect(badId.status).toBe(400); expect(badId.body.error.code).toBe("INVALID_OPERATION_ID");
    const badGeo = await reportReq(driver, t.id, { lat: "999" }).attach("photo", PHOTO, "e.jpg");
    expect(badGeo.status).toBe(400); expect(badGeo.body.error.code).toBe("INVALID_GEO");
  });

  it("feature OFF: reads AND mutations 404", async () => {
    const t = await inProgressTrip(); // trips router is unaffected by the flag
    process.env.FEATURE_EXCEPTIONS = "";
    const read = await api().get(`/api/v1/trips/${t.id}/exception`).set(auth(admin));
    expect(read.status).toBe(404);
    const mutate = await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    expect(mutate.status).toBe(404);
    process.env.FEATURE_EXCEPTIONS = "true";
  });

  it("adapter contract: evidence uploaded AUTHENTICATED to the exceptions folder; POD untouched", async () => {
    const t = await inProgressTrip();
    (uploadBuffer as unknown as { mockClear: () => void }).mockClear();
    await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    expect(uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), "uwc/exceptions", { type: "authenticated" });
    // POD-neutral: the stop's delivery gate fields are never touched by exception evidence.
    const stop = (await prisma.tripStop.findUnique({ where: { id: t.stops[0].id } }))!;
    expect(stop.pod_photo).toBeNull();
    expect(stop.do_uploaded).toBe(false);
  });

  // ── Barrier-forced interleavings (deterministic, not Promise.all-and-hope) ──

  it("BARRIER: report reaches commit first → a racing Arrived fails EXCEPTION_OPEN, writes nothing", async () => {
    const t = await inProgressTrip();
    const stopId = t.stops[0].id;
    const barrier = armBarrier("exceptionReport.beforeCommit");
    const reportP = fire(reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")); // holds the Trip lock at the hook
    await barrier.reached;
    const arrivedP = patchTrip(driver, t.id, { action: "arrived", stop_id: stopId }); // blocks on the lock
    barrier.release();
    const [report, arrived] = await Promise.all([reportP, arrivedP]);
    expect(report.status).toBe(201);
    expect(arrived.status).toBe(409);
    expect(arrived.body.error.code).toBe("EXCEPTION_OPEN");
    expect((await prisma.tripStop.findUnique({ where: { id: stopId } }))!.status).toBe("pending"); // arrived wrote nothing
  });

  it("BARRIER: Arrived commits first → a later report opens against the remaining trip", async () => {
    const t = await inProgressTrip();
    const stopId = t.stops[0].id;
    const barrier = armBarrier("arrived.beforeCommit");
    const arrivedP = fire(patchTrip(driver, t.id, { action: "arrived", stop_id: stopId })); // holds the lock at its hook
    await barrier.reached;
    const reportP = reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg"); // uploads, then blocks on the lock
    barrier.release();
    const [arrived, report] = await Promise.all([arrivedP, reportP]);
    expect(arrived.status).toBe(200);
    expect(report.status).toBe(201);
    expect((await prisma.tripStop.findUnique({ where: { id: stopId } }))!.status).toBe("arrived");
  });

  it("BARRIER: report racing a NON-final Delivered → delivery commits, report still opens", async () => {
    const t = await inProgressTripZones(["A2", "A1"]); // 2 stops
    const [s1] = [...t.stops].sort((a, b) => a.sequence - b.sequence);
    await arriveAndReadyPod(t.id, s1.id);
    const barrier = armBarrier("delivered.beforeCommit");
    const deliveredP = fire(patchTrip(driver, t.id, { action: "delivered", stop_id: s1.id })); // non-final → holds lock at hook
    await barrier.reached;
    const reportP = reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    barrier.release();
    const [delivered, report] = await Promise.all([deliveredP, reportP]);
    expect(delivered.status).toBe(200);
    expect(report.status).toBe(201); // trip still in_progress after a non-final delivery
    expect((await prisma.trip.findUnique({ where: { id: t.id } }))!.status).toBe("in_progress");
  });

  it("BARRIER: report racing FINAL Delivered/finalization → finalize wins, report fails (not eligible)", async () => {
    const t = await inProgressTrip(); // single stop
    const stopId = t.stops[0].id;
    await arriveAndReadyPod(t.id, stopId);
    const barrier = armBarrier("delivered.beforeCommit");
    const deliveredP = fire(patchTrip(driver, t.id, { action: "delivered", stop_id: stopId })); // final → proposes, holds lock at hook
    await barrier.reached;
    const reportP = reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg");
    barrier.release();
    const [delivered, report] = await Promise.all([deliveredP, reportP]);
    expect(delivered.status).toBe(200);
    expect(report.status).toBe(409); // trip is pending_approval — no longer eligible
    const trip = (await prisma.trip.findUnique({ where: { id: t.id } }))!;
    expect(trip.status).toBe("pending_approval");
    // The invariant the whole pass protects: never all-delivered + in_progress + open exception.
    expect(trip.open_exception_id).toBeNull();
    expect(await prisma.tripException.count({ where: { trip_id: t.id } })).toBe(0);
  });

  // ── Extended idempotency ──

  it("same admin action UUID submitted concurrently → both succeed idempotently, ONE action", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const cid = randomUUID();
    const verify = () => api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: cid });
    const [a, b] = await Promise.all([verify(), verify()]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect(await prisma.exceptionAction.count({ where: { exception_id: exId, type: "verify" } })).toBe(1);
  });

  it("same evidence UUID submitted concurrently → both succeed, ONE evidence row added", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const ev = randomUUID();
    const add = () => api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", ev).attach("photo", PHOTO, "same.jpg");
    const [a, b] = await Promise.all([add(), add()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    // report evidence (1) + exactly one resubmission (1) = 2.
    expect(await prisma.exceptionEvidence.count({ where: { exception_id: exId } })).toBe(2);
  });

  it("evidence UUID reused with a DIFFERENT photo → 409", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const ev = randomUUID();
    const first = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", ev).attach("photo", PHOTO, "a.jpg");
    expect(first.status).toBe(201);
    const reused = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", ev).attach("photo", Buffer.from("DIFFERENT-bytes"), "b.jpg");
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("evidence UUID reused with a DIFFERENT capture timestamp → 409", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const ev = randomUUID();
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", ev).field("captured_client_at", "2026-08-01T02:00:00.000Z").attach("photo", PHOTO, "a.jpg");
    const reused = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", ev).field("captured_client_at", "2026-08-01T09:00:00.000Z").attach("photo", PHOTO, "a.jpg");
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("report occurrence UUID reused with a changed action id / GPS / photo → 409", async () => {
    const t = await inProgressTrip();
    const occ = randomUUID();
    const ids = { client_occurrence_id: occ, client_action_id: randomUUID(), client_evidence_id: randomUUID() };
    await reportReq(driver, t.id, ids).attach("photo", PHOTO, "e.jpg");
    // changed client_action_id
    const changedAction = await reportReq(driver, t.id, { ...ids, client_action_id: randomUUID() }).attach("photo", PHOTO, "e.jpg");
    expect(changedAction.status).toBe(409);
    // changed GPS
    const changedGps = await reportReq(driver, t.id, { ...ids, lat: "1.0" }).attach("photo", PHOTO, "e.jpg");
    expect(changedGps.status).toBe(409);
    // changed photo bytes
    const changedPhoto = await reportReq(driver, t.id, ids).attach("photo", Buffer.from("OTHER"), "e.jpg");
    expect(changedPhoto.status).toBe(409);
  });

  it("admin op UUID reused with a different action/resolution/note → 409", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    const cid = randomUUID();
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: cid });
    // Same UUID, different action (reject).
    const asReject = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/reject`).set(auth(admin)).send({ client_action_id: cid, note: "different op" });
    expect(asReject.status).toBe(409);
    expect(asReject.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("evidence resubmission allowed after verified; BLOCKED after rejected and resolved", async () => {
    // One trip stays in_progress throughout (one-active-trip rule); each exception
    // is closed before the next opens.
    const t = await inProgressTrip();
    const addEvidence = (exId: string) =>
      api().post(`/api/v1/trips/${t.id}/exception/${exId}/evidence`).set(auth(driver)).field("client_evidence_id", randomUUID()).attach("photo", PHOTO, "x.jpg");

    // after VERIFIED (still open) → allowed
    const ex1 = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    await api().post(`/api/v1/trips/${t.id}/exception/${ex1}/verify`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect((await addEvidence(ex1)).status).toBe(201);
    await api().post(`/api/v1/trips/${t.id}/exception/${ex1}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() }); // close it

    // after REJECTED (closed) → 409 EXCEPTION_CLOSED
    const ex2 = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    await api().post(`/api/v1/trips/${t.id}/exception/${ex2}/reject`).set(auth(admin)).send({ client_action_id: randomUUID(), note: "no" });
    const afterRejected = await addEvidence(ex2);
    expect(afterRejected.status).toBe(409);
    expect(afterRejected.body.error.code).toBe("EXCEPTION_CLOSED");

    // after RESOLVED (closed) → 409 EXCEPTION_CLOSED
    const ex3 = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    await api().post(`/api/v1/trips/${t.id}/exception/${ex3}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    const afterResolved = await addEvidence(ex3);
    expect(afterResolved.status).toBe(409);
    expect(afterResolved.body.error.code).toBe("EXCEPTION_CLOSED");
  });

  it("pointer-clear failure rolls back the action, projection AND resolution", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;
    // Deliberately break the cache pointer so the close-time CAS matches 0 rows.
    await prisma.trip.update({ where: { id: t.id }, data: { open_exception_id: null } });

    const resume = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(resume.status).toBe(409);
    expect(resume.body.error.code).toBe("POINTER_INCONSISTENT");

    // Everything rolled back: exception still OPEN, no resume action, version unchanged.
    const exc = (await prisma.tripException.findUnique({ where: { id: exId } }))!;
    expect(exc.closed_at).toBeNull();
    expect(exc.current_state).toBe("reported");
    expect(exc.resolution).toBeNull();
    expect(await prisma.exceptionAction.count({ where: { exception_id: exId, type: "resume" } })).toBe(0);
  });

  it("admin open-exceptions list: admin-only, open-only, 404 when feature off", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const list = await api().get("/api/v1/trips/exceptions/open").set(auth(admin));
    expect(list.status).toBe(200);
    const row = (list.body.exceptions as Array<{ id: string; category: string; ticket_number: string }>).find((r) => r.id === exId);
    expect(row?.category).toBe("customer_site");
    expect(row?.ticket_number).toBeTruthy();

    // non-admin forbidden
    expect((await api().get("/api/v1/trips/exceptions/open").set(auth(driver))).status).toBe(403);
    expect((await api().get("/api/v1/trips/exceptions/open").set(auth(requestor))).status).toBe(403);

    // a closed exception drops off the list
    await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() });
    const after = await api().get("/api/v1/trips/exceptions/open").set(auth(admin));
    expect((after.body.exceptions as Array<{ id: string }>).find((r) => r.id === exId)).toBeUndefined();

    // feature off → 404
    process.env.FEATURE_EXCEPTIONS = "";
    expect((await api().get("/api/v1/trips/exceptions/open").set(auth(admin))).status).toBe(404);
    process.env.FEATURE_EXCEPTIONS = "true";
  });
});

/**
 * DRIVER SELF-RESUME — the flag-on blocker.
 *
 * An open exception blocks every delivery and the finalization on that trip. So
 * before this route a driver who reported a problem could do nothing at all
 * until an admin was at a screen: a report filed at 8pm stranded a loaded truck
 * and every remaining consignee on that run until morning.
 *
 * The money property is what makes it safe to give him: pay needs an admin
 * `verify` AND a `resume` closure (services/undeliveredPay). `verify` is
 * admin-only at the router and no driver route creates one, so a driver acting
 * alone closes with resume-and-no-verify — pays nothing, and the stop stays
 * outstanding and still his to deliver.
 */
describe("driver self-resume — unblocks the truck, decides no money", () => {
  // The suite above tears the flag down in its afterAll; re-arm it here.
  beforeAll(() => {
    process.env.FEATURE_EXCEPTIONS = "true";
  });
  afterAll(() => {
    delete process.env.FEATURE_EXCEPTIONS;
  });
  beforeEach(async () => {
    await resetDb();
  });

  /** in_progress trip with the driver's own OPEN exception on stop 1. */
  async function withOpenException() {
    const t = await inProgressTrip();
    const stopId = t.stops[0].id;
    const arrived = await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect(arrived.status).toBe(200);
    // reportReq builds the fields; the caller attaches the photo. trip_stop_id
    // matters here: the money assertions are about THIS stop.
    const reported = await reportReq(driver, t.id, { trip_stop_id: stopId }).attach("photo", PHOTO, "e.jpg");
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    return { tripId: t.id as string, stopId: stopId as string, exId: reported.body.exception.id as string };
  }
  const selfResume = (token: string, tripId: string, exId: string) =>
    api().post(`/api/v1/trips/${tripId}/exception/${exId}/self-resume`).set(auth(token)).send({ client_action_id: randomUUID() });

  it("closes his own exception and clears the trip's block", async () => {
    const { tripId, exId } = await withOpenException();
    const res = await selfResume(driver, tripId, exId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.exception.current_state).toBe("resolved");
    expect(res.body.exception.resolution).toBe("resume");

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.open_exception_id).toBeNull(); // the block is gone
    expect(trip.status).toBe("in_progress"); // and he is still out on the run
  });

  it("he can DELIVER again straight after — the actual point of the feature", async () => {
    const { tripId, stopId, exId } = await withOpenException();
    // While it was open, delivery is refused.
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    const blocked = await patchTrip(driver, tripId, { action: "delivered", stop_id: stopId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("EXCEPTION_OPEN");

    expect((await selfResume(driver, tripId, exId)).status).toBe(200);

    const ok = await patchTrip(driver, tripId, { action: "delivered", stop_id: stopId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("records actor_role driver — the log never reads as an office decision", async () => {
    const { tripId, exId } = await withOpenException();
    expect((await selfResume(driver, tripId, exId)).status).toBe(200);
    const action = await prisma.exceptionAction.findFirstOrThrow({ where: { exception_id: exId, type: "resume" } });
    expect(action.actor_role).toBe("driver");
  });

  it("MONEY: acting alone he pays himself NOTHING and the stop stays outstanding", async () => {
    const { tripId, stopId, exId } = await withOpenException();
    expect((await selfResume(driver, tripId, exId)).status).toBe(200);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.incentive_earned).toBeNull();
    // NOT finalized: with no admin verify the stop is not settled, so it is
    // still outstanding and still his to deliver.
    expect(trip.status).toBe("in_progress");
    expect((await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } })).points_awarded).toBeNull();

    // Closing it out therefore takes the UNPAID abort path.
    const abort = await api().patch(`/api/v1/trips/${tripId}/abort`).set(auth(admin)).send({ reason: "closed out" });
    expect(abort.status).toBe(200);
    const after = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(after.status).toBe("cancelled");
    expect(after.incentive_earned).toBeNull();
  });

  it("after an admin verify, self-resume leaves exactly the shape the pay rule keys on", async () => {
    // The cross-feature contract, asserted as DATA rather than as money,
    // because failed-delivery pay ships on its own branch (PR #40) and this
    // one must stand alone. PR #40 pays a stop iff its exception is
    // `resolved` + `resolution: "resume"` + has a `verify` action
    // (SETTLED_UNDELIVERED_WHERE). So: if the office verified and the DRIVER
    // then closed it, that predicate must match — the admin already made the
    // pay decision and he merely stopped waiting on them.
    const { tripId, exId } = await withOpenException();
    const verified = await api().post(`/api/v1/trips/${tripId}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: randomUUID() });
    expect(verified.status).toBe(200);
    expect((await selfResume(driver, tripId, exId)).status).toBe(200);

    const exc = await prisma.tripException.findUniqueOrThrow({
      where: { id: exId },
      include: { actions: true },
    });
    expect(exc.current_state).toBe("resolved");
    expect(exc.resolution).toBe("resume");
    const verifyAction = exc.actions.find((a) => a.type === "verify");
    expect(verifyAction).toBeDefined();
    expect(verifyAction!.actor_role).toBe("admin"); // the pay decision is the office's
    expect(exc.actions.find((a) => a.type === "resume")!.actor_role).toBe("driver");
  });

  it("acting ALONE he never produces a verify action — the pay predicate cannot match", async () => {
    // The mirror of the above, and the reason this route is safe to give him.
    const { tripId, exId } = await withOpenException();
    expect((await selfResume(driver, tripId, exId)).status).toBe(200);
    const actions = await prisma.exceptionAction.findMany({ where: { exception_id: exId } });
    expect(actions.some((a) => a.type === "verify")).toBe(false);
  });

  it("cannot self-resume a trip that is not his", async () => {
    const { tripId, exId } = await withOpenException();
    const res = await selfResume(requestor, tripId, exId);
    expect([403, 404]).toContain(res.status); // role gate or ownership — never 200
  });

  it("an ADMIN cannot use the driver route (role-gated, not a shortcut)", async () => {
    const { tripId, exId } = await withOpenException();
    expect((await selfResume(admin, tripId, exId)).status).toBe(403);
  });

  it("is idempotent on replay and refuses a stale version", async () => {
    const { tripId, exId } = await withOpenException();
    const opId = randomUUID();
    const first = await api().post(`/api/v1/trips/${tripId}/exception/${exId}/self-resume`).set(auth(driver)).send({ client_action_id: opId });
    expect(first.status).toBe(200);
    // Same op id, same payload → the original result, not a second action.
    const replay = await api().post(`/api/v1/trips/${tripId}/exception/${exId}/self-resume`).set(auth(driver)).send({ client_action_id: opId });
    expect(replay.status).toBe(200);
    expect(await prisma.exceptionAction.count({ where: { exception_id: exId, type: "resume" } })).toBe(1);
    // And a closed exception cannot be reopened by another attempt.
    const again = await selfResume(driver, tripId, exId);
    expect(again.status).toBe(409);
  });
});
