import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, REQUESTOR, DRIVER } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  userIdByPhone,
  DRIVERS,
} from "./helpers/flow";
import { cloudinary } from "../src/lib/cloudinary";

/**
 * POD PHOTO PRIVACY: photos are private (authenticated Cloudinary assets) served
 * as signed, unguessable URLs; and locked once the trip is finalized. Existing
 * (legacy) public photos keep working until the backfill secures them.
 */

const PLX = DRIVERS.PLX;

beforeAll(() => {
  // Deterministic signing so the serializer produces a checkable URL (the real
  // CLOUDINARY_* env isn't set in the integration harness).
  cloudinary.config({ cloud_name: "testcloud", api_key: "k", api_secret: "s", secure: true });
});

async function setup() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  const rt = await firstRouteTypeId(requestor);
  const plx = await userIdByPhone(PLX.phone);
  return { requestor, admin, driver, rt, plx };
}

describe("POD photo privacy", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("locks the POD once the trip is finalized → 409 POD_LOCKED (before any upload)", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);
    await arriveAndDeliver(driver, trip.id, trip.stops[0].id); // → completed

    expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.status).toBe("completed");

    // A fake photo just satisfies multer's file check; the lock fires before any
    // Cloudinary call, so no upload happens.
    const res = await api()
      .post(`/api/v1/trips/${trip.id}/stops/${trip.stops[0].id}/pod`)
      .set(auth(driver))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), "pod.jpg");

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("POD_LOCKED");
  });

  it("serves a SIGNED, unguessable URL for a stop that has a pod_public_id (never the stored value)", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);

    // Simulate a secured upload: private asset id + the stored (non-public) URL.
    const publicId = "uwc/pod/TKT-A-stop-1";
    const stored = "https://res.cloudinary.com/testcloud/image/authenticated/uwc/pod/TKT-A-stop-1";
    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: { pod_public_id: publicId, pod_photo: stored, do_uploaded: true },
    });

    const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    const served = res.body.stops[0].pod_photo as string;
    expect(served).toContain("/authenticated/");
    expect(served).toContain("s--"); // signed — unforgeable without the API secret
    expect(served).toContain(publicId);
    expect(served).not.toBe(stored); // the raw stored value is never handed out
  });

  it("serves a LEGACY stop (no pod_public_id) unchanged — backward compatible", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);

    const legacy = "https://res.cloudinary.com/dultrxlvm/image/upload/uwc/pod/OLD-stop-1.jpg";
    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: { pod_photo: legacy, do_uploaded: true }, // pod_public_id stays null
    });

    const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.stops[0].pod_photo).toBe(legacy); // untouched until the backfill
  });

  it("the signed URL also flows through the LIST endpoint (not only detail)", async () => {
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);
    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: { pod_public_id: "uwc/pod/TKT-B-stop-1", do_uploaded: true },
    });

    const res = await api().get("/api/v1/trips").set(auth(admin));
    expect(res.status).toBe(200);
    const found = (res.body as { id: string; stops: { pod_photo: string | null }[] }[]).find(
      (t) => t.id === trip.id
    );
    expect(found!.stops[0].pod_photo).toContain("s--");
  });
});
