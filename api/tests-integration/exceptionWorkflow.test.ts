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

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip } from "./helpers/flow";

const PLX_PLATE = "PLX 2406";
const PHOTO = Buffer.from("fake-jpeg-bytes");

// Cached once in beforeAll — the general rate limiter is one budget per IP for
// the whole in-process app, so we log in ONCE (resetDb does not wipe users, so
// the tokens stay valid across tests) rather than on every test.
let requestor = "";
let admin = "";
let driver = "";
let driverId = "";
let rt = "";

/** Book A2 → assign PLX → start. Leaves the trip in_progress. */
async function inProgressTrip() {
  const t = await bookTrip(requestor, ["A2"], rt);
  await approveTrip(admin, t.id, driverId, PLX_PLATE);
  await startTrip(driver, t.id);
  return t;
}

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

  it("idempotent replay: same client_occurrence_id returns the same row, no duplicate", async () => {
    const t = await inProgressTrip();

    const occ = randomUUID();
    const first = await reportReq(driver, t.id, { client_occurrence_id: occ }).attach("photo", PHOTO, "e.jpg");
    expect(first.status).toBe(201);
    const second = await reportReq(driver, t.id, { client_occurrence_id: occ }).attach("photo", PHOTO, "e.jpg");
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

  it("driver resume (CAN CONTINUE) → resolved(resume), closed, trip in_progress", async () => {
    const t = await inProgressTrip();
    const exId = (await reportReq(driver, t.id).attach("photo", PHOTO, "e.jpg")).body.exception.id;

    const resumed = await api().post(`/api/v1/trips/${t.id}/exception/${exId}/resume`).set(auth(driver)).send({ client_action_id: randomUUID() });
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
});
