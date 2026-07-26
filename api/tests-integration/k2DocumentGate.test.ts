import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip, arriveRaw, deliverRaw } from "./helpers/flow";
import { cloudinary } from "../src/lib/cloudinary";

// Q6 (Mr. Teh R1 2026-07-24): a K2-zone delivery requires the UPLOADED Borang K2
// document, not a checkbox tick. Pay stays gated on the existing admin POD/
// incentive approval — this test proves the DOCUMENT gate; it changes no money.

const PLX = "PLX 2406";
let admin = "", driver = "", requestor = "", driverId = "", rt = "";

/** Book a K2 stop → assign → start → arrive → stub the POD (no Cloudinary). */
async function readyK2Stop() {
  const t = await bookTrip(requestor, ["K2"], rt);
  await approveTrip(admin, t.id, driverId, PLX);
  await startTrip(driver, t.id);
  const stopId = t.stops[0].id;
  expect((await arriveRaw(driver, t.id, stopId)).status).toBe(200);
  await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
  return { tripId: t.id, stopId };
}

describe("K2 document gate — Q6", () => {
  beforeAll(async () => {
    // Deterministic signing, exactly as podPrivacy.test.ts does: the trip
    // serializer mints a SIGNED url for any stored k2_public_id, and the real
    // CLOUDINARY_* env is not set in the integration harness — unconfigured,
    // cloudinary.url() throws ("Must supply cloud_name") and the delivery 500s.
    cloudinary.config({ cloud_name: "testcloud", api_key: "k", api_secret: "s", secure: true });
    [admin, driver, requestor] = await Promise.all([loginAs(ADMIN), loginAs(DRIVER), loginAs(REQUESTOR)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  it("blocks delivery of a K2 stop until the K2 document is uploaded", async () => {
    const { tripId, stopId } = await readyK2Stop();

    // POD present but NO K2 document → delivery blocked.
    const blocked = await deliverRaw(driver, tripId, stopId);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("DOCUMENTATION_INCOMPLETE");

    // A legacy tick alone is NOT enough (the gate keys on the uploaded document).
    await prisma.tripStop.update({ where: { id: stopId }, data: { k2_form_ack: true } });
    expect((await deliverRaw(driver, tripId, stopId)).status).toBe(400);

    // Upload the K2 document (stubbed like the POD helper) → delivery proceeds.
    await prisma.tripStop.update({ where: { id: stopId }, data: { k2_photo: "test://k2.jpg", k2_public_id: "uwc/k2/x" } });
    const ok = await deliverRaw(driver, tripId, stopId);
    expect(ok.status).toBe(200);
    // Single-stop K2 trip finalizes to pending_approval (admin validates + approves).
    expect((await prisma.trip.findUnique({ where: { id: tripId } }))!.status).toBe("pending_approval");
  });

  it("non-K2 zones are unaffected by the K2 document requirement", async () => {
    const t = await bookTrip(requestor, ["A2"], rt); // Ipoh, not K2
    await approveTrip(admin, t.id, driverId, PLX);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveRaw(driver, t.id, stopId);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, t.id, stopId)).status).toBe(200); // no K2 doc needed
  });

  it("K2 upload route: requires a file and the assigned driver", async () => {
    const { tripId, stopId } = await readyK2Stop();
    // No file → 400.
    const noFile = await api().post(`/api/v1/trips/${tripId}/stops/${stopId}/k2`).set(auth(driver));
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe("NO_FILE");
    // Wrong role (admin) → 403 (route is driver-only).
    const asAdmin = await api().post(`/api/v1/trips/${tripId}/stops/${stopId}/k2`).set(auth(admin));
    expect(asAdmin.status).toBe(403);
  });
});
