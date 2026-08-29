import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  userIdByPhone,
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveRaw,
  deliverRaw,
  approveIncentiveRaw,
} from "./helpers/flow";
import { cloudinary } from "../src/lib/cloudinary";

// Q6 (Mr. Teh R1 2026-07-24): the gated delivery requires the UPLOADED customs
// document, not a checkbox tick. Pay stays gated on the existing admin POD/
// incentive approval — this test proves the DOCUMENT gate; it changes no money.
//
// ⚠ WHICH delivery is gated changed on 29 Jul 2026. It was zone "K2" (Sungai
// Petani + Kuala Ketil), which was simply wrong — the feature is named after
// Borang K2 and the zone code "K2" is an unrelated coincidence. Mr. Teh, R3:
// "Only Penang bayan Lepas area require K2." That is an AREA inside zone P1,
// so the fixture below books the Bayan Lepas consignee, not a zone.

const PND = "PND 1888";
let admin = "", driver = "", requestor = "", driverId = "", rt = "";

/** Book a Bayan Lepas stop → assign → start → arrive → stub the POD. */
async function readyK2Stop() {
  const t = await bookTrip(requestor, ["BAYAN_LEPAS"], rt);
  await approveTrip(admin, t.id, driverId, PND);
  await startTrip(driver, t.id);
  const stopId = t.stops[0].id;
  expect((await arriveRaw(driver, t.id, stopId)).status).toBe(200);
  await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
  return { tripId: t.id, stopId };
}

describe("customs document gate — Q6", () => {
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

  it("blocks delivery of a Bayan Lepas stop until the customs document is uploaded", async () => {
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
    // Single-stop gated trip finalizes to pending_approval (admin validates + approves).
    expect((await prisma.trip.findUnique({ where: { id: tripId } }))!.status).toBe("pending_approval");
  });

  it("other zones are unaffected by the customs-document requirement", async () => {
    const t = await bookTrip(requestor, ["A2"], rt); // Ipoh
    await approveTrip(admin, t.id, driverId, PND);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveRaw(driver, t.id, stopId);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, t.id, stopId)).status).toBe(200); // no document needed
  });

  it("REGRESSION: the zone CALLED K2 (Sungai Petani) needs no document", async () => {
    // The original bug: this delivery used to be refused, stranding the driver
    // at a stop he had no way to complete.
    const t = await bookTrip(requestor, ["K2"], rt);
    await approveTrip(admin, t.id, driverId, PND);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveRaw(driver, t.id, stopId);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, t.id, stopId)).status).toBe(200);
  });

  it("FAILS OPEN: a P1 stop with no area recorded is deliverable", async () => {
    // A requestor-added consignee with a blank area must never strand a driver;
    // a missing document is recoverable at POD approval (owner ruling, 29 Jul).
    const t = await bookTrip(requestor, ["P1"], rt); // ad-hoc P1 consignee, area null
    await approveTrip(admin, t.id, driverId, PND);
    await startTrip(driver, t.id);
    const stopId = t.stops[0].id;
    await arriveRaw(driver, t.id, stopId);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    expect((await deliverRaw(driver, t.id, stopId)).status).toBe(200);
  });

  it("customs upload route: requires a file and the assigned driver", async () => {
    const { tripId, stopId } = await readyK2Stop();
    // No file → 400.
    const noFile = await api().post(`/api/v1/trips/${tripId}/stops/${stopId}/k2`).set(auth(driver));
    expect(noFile.status).toBe(400);
    expect(noFile.body.error.code).toBe("NO_FILE");
    // Wrong role (admin) → 403 (route is driver-only).
    const asAdmin = await api().post(`/api/v1/trips/${tripId}/stops/${stopId}/k2`).set(auth(admin));
    expect(asAdmin.status).toBe(403);
  });

  // Until this coverage existed, the admin app's "approve without the customs
  // document?" confirm dialog was PURE UI — nothing on the server checked
  // k2_photo at approval, so a direct API call skipped the confirm entirely,
  // with no trace of it having happened. This proves the server now enforces
  // what the dialog only used to ask about.
  describe("approve-incentive enforces the K2 confirm server-side, not just in the admin app", () => {
    /** A stop delivered normally (K2 uploaded, exactly like readyK2Stop's
     *  caller does) and then stripped of its k2_photo directly — simulating
     *  the one way this combination exists today: a legacy row predating the
     *  29 Jul zone fix. The normal delivery route cannot produce it (that is
     *  the whole point of the upload gate), so this is the only way to reach
     *  the approval-time defense at all. */
    async function deliveredWithMissingK2() {
      const { tripId, stopId } = await readyK2Stop();
      await prisma.tripStop.update({ where: { id: stopId }, data: { k2_photo: "test://k2.jpg", k2_public_id: "uwc/k2/x" } });
      expect((await deliverRaw(driver, tripId, stopId)).status).toBe(200);
      await prisma.tripStop.update({ where: { id: stopId }, data: { k2_photo: null, k2_public_id: null } });
      return { tripId, stopId };
    }

    it("refuses approval with no override reason", async () => {
      const { tripId } = await deliveredWithMissingK2();
      const res = await approveIncentiveRaw(admin, tripId);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("K2_MISSING_CONFIRM_REQUIRED");
      expect((await prisma.trip.findUnique({ where: { id: tripId } }))!.status).toBe("pending_approval");
    });

    it("refuses a whitespace-only override reason the same way", async () => {
      const { tripId } = await deliveredWithMissingK2();
      const res = await approveIncentiveRaw(admin, tripId, { k2_override_reason: "   " });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("K2_MISSING_CONFIRM_REQUIRED");
    });

    it("approves once an override reason is given, and records why", async () => {
      const { tripId, stopId } = await deliveredWithMissingK2();
      const res = await approveIncentiveRaw(admin, tripId, {
        k2_override_reason: "legacy row, predates the 29 Jul zone fix",
      });
      expect(res.status).toBe(200);
      expect((await prisma.trip.findUnique({ where: { id: tripId } }))!.status).toBe("completed");

      const log = await prisma.auditLog.findFirst({
        where: { table_name: "Trip", record_id: tripId, action: { contains: "K2 override" } },
        orderBy: { timestamp: "desc" },
      });
      expect(log?.action).toContain("legacy row, predates the 29 Jul zone fix");
      // Names the actual stop, not just "something was overridden".
      const stop = await prisma.tripStop.findUnique({ where: { id: stopId } });
      expect(log?.action).toContain(`stop ${stop!.sequence}`);
    });

    it("a normal approval (K2 present) is unaffected", async () => {
      const { tripId, stopId } = await readyK2Stop();
      await prisma.tripStop.update({ where: { id: stopId }, data: { k2_photo: "test://k2.jpg", k2_public_id: "uwc/k2/x" } });
      expect((await deliverRaw(driver, tripId, stopId)).status).toBe(200);
      const res = await approveIncentiveRaw(admin, tripId);
      expect(res.status).toBe(200);
    });
  });
});
