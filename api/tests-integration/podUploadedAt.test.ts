import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";

// Cloudinary is not configured in the integration harness. Mock the adapter so a
// SUCCESSFUL upload is reachable — the POD-lock test in podPrivacy.test.ts only
// ever exercises the refusal path, which returns before any upload.
vi.mock("../src/lib/cloudinary", () => ({
  uploadBuffer: vi.fn(async () => ({
    url: "https://res.cloudinary.test/uwc/pod/authenticated",
    publicId: "uwc/pod/TKT-stop-1",
    resourceType: "image",
    format: "jpg",
  })),
  isCloudinaryConfigured: () => true,
  cloudinary: { config: () => {}, url: (publicId: string) => `https://res.cloudinary.test/signed/${publicId}` },
}));

import { api, prisma, resetDb, loginAs, auth, ADMIN, REQUESTOR, DRIVER } from "./helpers/harness";
import { firstRouteTypeId, bookTrip, approveTrip, startTrip, userIdByPhone, DRIVERS } from "./helpers/flow";

/**
 * IM6 — TripStop.pod_uploaded_at.
 *
 * Before this column the upload time lived only in React state, so the driver's
 * green "POD uploaded · 9:47 AM" line went untimed on any remount, and — the
 * reason it matters — the system could not say WHEN a POD was taken. In a
 * disputed POD approval or a late-abort argument that timestamp is the evidence,
 * and it existed nowhere but Cloudinary's own asset metadata.
 */

const PND = DRIVERS.PND;
const PHOTO = Buffer.from("fake-jpeg-bytes");

async function setup() {
  const [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
  const rt = await firstRouteTypeId(requestor);
  const plx = await userIdByPhone(PND.phone);
  return { requestor, admin, driver, rt, plx };
}

async function inProgressTrip() {
  const { requestor, admin, driver, rt, plx } = await setup();
  const trip = await bookTrip(requestor, ["P1"], rt);
  await approveTrip(admin, trip.id, plx, PND.plate);
  await startTrip(driver, trip.id);
  return { trip, driver, admin };
}

const uploadPod = (driver: string, tripId: string, stopId: string) =>
  api()
    .post(`/api/v1/trips/${tripId}/stops/${stopId}/pod`)
    .set(auth(driver))
    .attach("photo", PHOTO, "pod.jpg");

describe("POD upload time is persisted (IM6)", () => {
  beforeAll(() => {
    process.env.TZ = process.env.TZ ?? "UTC";
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("is NULL before any upload", async () => {
    const { trip } = await inProgressTrip();
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } });
    expect(stop.pod_uploaded_at).toBeNull();
  });

  it("is set to the SERVER receipt time when the POD is uploaded", async () => {
    const { trip, driver } = await inProgressTrip();
    const before = new Date();

    const res = await uploadPod(driver, trip.id, trip.stops[0].id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const after = new Date();
    const stop = await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } });
    expect(stop.pod_uploaded_at).not.toBeNull();
    expect(stop.pod_photo).not.toBeNull();
    // Server clock, bounded by the request — not a client-supplied value. The
    // device is a party to any dispute this timestamp settles.
    expect(stop.pod_uploaded_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(stop.pod_uploaded_at!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("ships to the client on the trip payload, so it survives a remount", async () => {
    // The whole point: the green line used to lose its time on refetch because
    // the value existed only in component state.
    const { trip, driver } = await inProgressTrip();
    expect((await uploadPod(driver, trip.id, trip.stops[0].id)).status).toBe(201);

    const fetched = await api().get(`/api/v1/trips/${trip.id}`).set(auth(driver));
    expect(fetched.status).toBe(200);
    const stop = fetched.body.stops.find((s: { id: string }) => s.id === trip.stops[0].id);
    expect(stop.pod_uploaded_at).toBeTruthy();
    expect(new Date(stop.pod_uploaded_at).toString()).not.toBe("Invalid Date");
  });

  it("a retake re-times the POD, because it times the photo actually stored", async () => {
    const { trip, driver } = await inProgressTrip();
    expect((await uploadPod(driver, trip.id, trip.stops[0].id)).status).toBe(201);
    const first = (await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } })).pod_uploaded_at!;

    await new Promise((r) => setTimeout(r, 10));
    expect((await uploadPod(driver, trip.id, trip.stops[0].id)).status).toBe(201);
    const second = (await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } })).pod_uploaded_at!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("does not move once the trip is finalized — the POD lock covers it", async () => {
    // The admin approves against this evidence, so neither the photo nor its
    // time may change while the trip awaits sign-off.
    const { trip, driver } = await inProgressTrip();
    expect((await uploadPod(driver, trip.id, trip.stops[0].id)).status).toBe(201);
    const at = (await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } })).pod_uploaded_at!;

    await prisma.trip.update({ where: { id: trip.id }, data: { status: "pending_approval" } });

    const res = await uploadPod(driver, trip.id, trip.stops[0].id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("POD_LOCKED");

    const unchanged = (await prisma.tripStop.findUniqueOrThrow({ where: { id: trip.stops[0].id } })).pod_uploaded_at!;
    expect(unchanged.getTime()).toBe(at.getTime());
  });
});
