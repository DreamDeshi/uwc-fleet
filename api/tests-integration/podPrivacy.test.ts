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

const PND = DRIVERS.PND;

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
  const plx = await userIdByPhone(PND.phone);
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
    await approveTrip(admin, trip.id, plx, PND.plate);
    await startTrip(driver, trip.id);
    await arriveAndDeliver(driver, trip.id, trip.stops[0].id); // → pending_approval

    // The POD locks the moment delivery is recorded (pending_approval) — the
    // admin approves against this evidence, so it must not change under review.
    expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.status).toBe("pending_approval");

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
    await approveTrip(admin, trip.id, plx, PND.plate);
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
    await approveTrip(admin, trip.id, plx, PND.plate);
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
    await approveTrip(admin, trip.id, plx, PND.plate);
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

  it("serves a SIGNED URL for a trip DOCUMENT with a public_id (extension preserved)", async () => {
    const { requestor, admin, rt } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await prisma.tripDocument.create({
      data: {
        trip_id: trip.id,
        type: "do_photo",
        file_url: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/documents/abc123",
        public_id: "uwc/documents/abc123",
        resource_type: "image",
        format: "jpg",
      },
    });

    const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    const served = res.body.documents[0].file_url as string;
    expect(served).toContain("/authenticated/");
    expect(served).toContain("s--");
    expect(served).toMatch(/uwc\/documents\/abc123\.jpg/); // extension kept for the client's image check
  });

  it("serves a LEGACY document (no public_id) unchanged — backward compatible", async () => {
    const { requestor, admin, rt } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    const legacy = "https://res.cloudinary.com/dultrxlvm/image/upload/uwc/documents/old-doc.pdf";
    await prisma.tripDocument.create({
      data: { trip_id: trip.id, type: "other", file_url: legacy }, // public_id stays null
    });

    const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.documents[0].file_url).toBe(legacy);
  });
  it("never hands out the stored asset id itself — to ANY role", async () => {
    // The signing pipeline exists because asset ids were published and, for
    // PODs, were deterministic (`<ticket>-stop-<n>`) and enumerable by ticket.
    // It stopped the URLs being guessable but kept shipping the id, on every
    // trip read, to every role — the exact string the work was meant to
    // withhold. No client reads it; the signed URL is the only usable artefact.
    const { requestor, admin, driver, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND.plate);
    await startTrip(driver, trip.id);

    await prisma.tripStop.update({
      where: { id: trip.stops[0].id },
      data: {
        pod_public_id: "uwc/pod/TKT-C-stop-1",
        k2_public_id: "uwc/k2/TKT-C-stop-1",
        pod_photo: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/pod/TKT-C-stop-1",
        k2_photo: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/k2/TKT-C-stop-1",
        do_uploaded: true,
      },
    });

    for (const [role, token] of [["admin", admin], ["driver", driver], ["requestor", requestor]] as const) {
      const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(token));
      expect(res.status, role).toBe(200);
      const stop = res.body.stops[0];

      // The identifier is gone…
      expect(stop.pod_public_id, `${role} still receives pod_public_id`).toBeUndefined();
      expect(stop.k2_public_id, `${role} still receives k2_public_id`).toBeUndefined();
      // …and it is not hiding anywhere else in the payload either.
      expect(JSON.stringify(res.body)).not.toContain('"pod_public_id"');
      expect(JSON.stringify(res.body)).not.toContain('"k2_public_id"');

      // …while the thing the client actually uses still works. Dropping the id
      // must not cost the signed URL, which is derived from it.
      expect(stop.pod_photo, `${role} lost the signed POD url`).toContain("s--");
      expect(stop.pod_photo).toContain("/authenticated/");
      expect(stop.k2_photo, `${role} lost the signed K2 url`).toContain("s--");
    }
  });

  it("never hands out a DOCUMENT's public_id, while still signing its url", async () => {
    const { requestor, admin, rt, plx } = await setup();
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PND.plate);
    await prisma.tripDocument.create({
      data: {
        trip_id: trip.id,
        type: "do_photo",
        public_id: "uwc/docs/TKT-C-do",
        resource_type: "image",
        format: "jpg",
        file_url: "https://res.cloudinary.com/testcloud/image/authenticated/uwc/docs/TKT-C-do.jpg",
      },
    });

    const res = await api().get(`/api/v1/trips/${trip.id}`).set(auth(admin));
    expect(res.status).toBe(200);
    const doc = res.body.documents[0];
    expect(doc.public_id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"public_id"');
    expect(doc.file_url).toContain("s--");
    expect(doc.file_url).toContain(".jpg"); // extension still preserved
  });

});
