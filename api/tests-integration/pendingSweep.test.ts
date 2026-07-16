import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// Mock the push transport so "the alert fired exactly once" is a call-count
// assertion instead of a real Expo API hit. Hoisted above all imports, so the
// sweep (and the routes) see the mock.
vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { prisma, resetDb, loginAs, REQUESTOR } from "./helpers/harness";
import { bookTrip, firstRouteTypeId, pickupDateKey } from "./helpers/flow";
import { sweepPendingTrips } from "../src/services/pendingTripAlerts";
import { sendPushNotifications } from "../src/lib/pushNotifications";

/**
 * PENDING SWEEP — retrying is decoupled from alerting (dead-zone fix,
 * audit 2026-07-16). The sweep used to select only pending_alert_sent=false,
 * so once a booking's 10-minute admin alert fired, auto-dispatch never
 * re-evaluated it — even when a driver freed up. Now:
 *   - the retry covers EVERY stale pending booking, alerted or not;
 *   - the alert still fires exactly once per booking (one-shot preserved).
 * Each test drives sweepPendingTrips() directly — deterministic, no timers.
 */

const pushMock = vi.mocked(sendPushNotifications);

/** How many "pending order" alerts have been pushed for this trip. */
function pendingAlertCount(tripId: string): number {
  return pushMock.mock.calls.filter(([, payload]) => {
    const data = payload?.data as { type?: string; tripId?: string } | undefined;
    return data?.type === "pending_alert" && data?.tripId === tripId;
  }).length;
}

async function setMode(mode: "auto" | "manual"): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: "singleton" },
    update: { dispatch_mode: mode },
    create: { id: "singleton", dispatch_mode: mode },
  });
}

/** Block dispatch deterministically: every driver on leave for the pickup day. */
async function putAllDriversOnLeave(): Promise<string[]> {
  const drivers = await prisma.user.findMany({ where: { role: "driver" }, select: { id: true } });
  expect(drivers.length).toBeGreaterThan(0);
  const day = pickupDateKey();
  const rows = await Promise.all(
    drivers.map((d) =>
      prisma.driverLeave.create({
        data: { driver_id: d.id, start_date: day, end_date: day, note: "sweep test" },
      })
    )
  );
  return rows.map((r) => r.id);
}

/** Age the booking past the 10-minute alert threshold. */
async function backdate(tripId: string): Promise<void> {
  await prisma.trip.update({
    where: { id: tripId },
    data: { created_at: new Date(Date.now() - 11 * 60 * 1000) },
  });
}

const freshTrip = (id: string) => prisma.trip.findUniqueOrThrow({ where: { id } });

describe("pending sweep — retry decoupled from the one-shot alert", () => {
  beforeEach(async () => {
    await resetDb(); // also truncates DriverLeave
    pushMock.mockClear();
  });
  afterEach(async () => {
    await setMode("manual"); // never leak auto mode into other files
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("AUTO: an ALERTED booking is still retried and gets picked up when a driver frees; the alert fires exactly once", async () => {
    await setMode("auto");
    const leaves = await putAllDriversOnLeave();

    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt); // create-time dispatch finds no drivers
    expect((await freshTrip(trip.id)).status).toBe("pending");
    await backdate(trip.id);

    // Sweep #1: still blocked → the one-shot alert fires.
    await sweepPendingTrips();
    let t = await freshTrip(trip.id);
    expect(t.status).toBe("pending");
    expect(t.pending_alert_sent).toBe(true);
    expect(pendingAlertCount(trip.id)).toBe(1);

    // Sweep #2: still blocked, already alerted — retried, NOT re-alerted.
    await sweepPendingTrips();
    t = await freshTrip(trip.id);
    expect(t.status).toBe("pending");
    expect(pendingAlertCount(trip.id)).toBe(1);

    // A driver frees up (leave removed). The next sweep must pick the booking
    // up even though pending_alert_sent=true — THE dead-zone fix.
    await prisma.driverLeave.deleteMany({ where: { id: { in: leaves } } });
    await sweepPendingTrips();
    t = await freshTrip(trip.id);
    expect(t.status).toBe("assigned");
    expect(t.driver_id).not.toBeNull();
    expect(t.truck_plate).not.toBeNull();
    expect(t.auto_dispatch_failed).toBe(false);

    // Across the booking's whole life: exactly one admin alert.
    expect(pendingAlertCount(trip.id)).toBe(1);
  });

  it("MANUAL: the sweep alerts once and never dispatches or re-alerts", async () => {
    await setMode("manual");
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await backdate(trip.id);

    await sweepPendingTrips();
    let t = await freshTrip(trip.id);
    expect(t.status).toBe("pending");
    expect(t.driver_id).toBeNull(); // manual mode: the sweep never assigns
    expect(t.pending_alert_sent).toBe(true);
    expect(pendingAlertCount(trip.id)).toBe(1);

    await sweepPendingTrips();
    t = await freshTrip(trip.id);
    expect(t.status).toBe("pending");
    expect(pendingAlertCount(trip.id)).toBe(1); // still one-shot
  });

  it("a booking younger than the threshold is untouched by the sweep", async () => {
    await setMode("auto");
    await putAllDriversOnLeave(); // even in auto mode, nothing should touch it
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["P1"], rt); // NOT backdated

    await sweepPendingTrips();
    const t = await freshTrip(trip.id);
    expect(t.status).toBe("pending");
    expect(t.pending_alert_sent).toBe(false);
    expect(pendingAlertCount(trip.id)).toBe(0);
  });
});
