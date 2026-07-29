import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the push transport — assertions are call-counts, not Expo hits.
vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { api, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { bookTrip, firstRouteTypeId, approveTrip, userIdByPhone } from "./helpers/flow";
import { sendPushNotifications } from "../src/lib/pushNotifications";

/**
 * DG-R1 — the requestor hears about their delivery's lifecycle:
 *   start          → "trip_started" push (was: silence)
 *   non-final stop → "stop_delivered" push (was: silence until the LAST drop)
 *   final stop     → the existing "trip_delivered" push, and NO stop_delivered
 *                    duplicate for that stop.
 * The POD gate is satisfied by writing the stop columns directly (same
 * approach as podPrivacy) so no Cloudinary is involved.
 */

const pushMock = vi.mocked(sendPushNotifications);

function pushesOfType(type: string): number {
  return pushMock.mock.calls.filter(([, payload]) => {
    const data = payload?.data as { type?: string } | undefined;
    return data?.type === type;
  }).length;
}

async function satisfyDocsGate(stopId: string): Promise<void> {
  await prisma.tripStop.update({
    where: { id: stopId },
    data: { pod_photo: "https://example.invalid/pod.jpg", do_uploaded: true, k2_form_ack: true },
  });
}

describe("requestor lifecycle pushes (DG-R1)", () => {
  beforeEach(async () => {
    await resetDb();
    pushMock.mockClear();
  });

  it("pushes the requestor on start, each non-final stop, and final delivery exactly once each", async () => {
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const driver = await loginAs(DRIVER);
    const driverId = await userIdByPhone(DRIVER.phone);

    const trip = await bookTrip(requestor, ["A1", "A2"], await firstRouteTypeId(requestor));
    await approveTrip(admin, trip.id, driverId, "PND 1888");

    const start = await api()
      .patch(`/api/v1/trips/${trip.id}/status`)
      .set("Authorization", `Bearer ${driver}`)
      .send({ action: "start" });
    expect(start.status).toBe(200);
    expect(pushesOfType("trip_started")).toBe(1);

    const stops = await prisma.tripStop.findMany({
      where: { trip_id: trip.id },
      orderBy: { sequence: "asc" },
    });
    expect(stops).toHaveLength(2);

    // Stop 1 of 2 — NON-final: a stop_delivered push, no trip_delivered yet.
    await satisfyDocsGate(stops[0].id);
    for (const action of ["arrived", "delivered"] as const) {
      const res = await api()
        .patch(`/api/v1/trips/${trip.id}/status`)
        .set("Authorization", `Bearer ${driver}`)
        .send({ action, stop_id: stops[0].id });
      expect(res.status).toBe(200);
    }
    expect(pushesOfType("stop_delivered")).toBe(1);
    expect(pushesOfType("trip_delivered")).toBe(0);

    // Stop 2 of 2 — FINAL: the trip_delivered push, and no extra stop_delivered.
    await satisfyDocsGate(stops[1].id);
    for (const action of ["arrived", "delivered"] as const) {
      const res = await api()
        .patch(`/api/v1/trips/${trip.id}/status`)
        .set("Authorization", `Bearer ${driver}`)
        .send({ action, stop_id: stops[1].id });
      expect(res.status).toBe(200);
    }
    expect(pushesOfType("stop_delivered")).toBe(1);
    expect(pushesOfType("trip_delivered")).toBe(1);
  });
});
