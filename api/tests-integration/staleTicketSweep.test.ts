import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Silence the requestor/driver push on auto-cancel (no real Expo hit).
vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { bookTrip, firstRouteTypeId, approveTrip, startTrip, userIdByPhone } from "./helpers/flow";
import { sweepStaleTickets } from "../src/services/staleTicketSweep";
import { mytDayStart } from "../src/lib/myt";

/**
 * The 3am stale-ticket auto-cancel (feedback item 8) end-to-end through Postgres.
 * "Undelivered from a prior day → cancelled + capacity freed", with the confirmed
 * scope: not-yet-started only (never in_progress or delivered), prior days only.
 */

const PLX_PLATE = "PLX 2406";

async function setManual() {
  await prisma.appSetting.upsert({
    where: { id: "singleton" },
    update: { dispatch_mode: "manual" },
    create: { id: "singleton", dispatch_mode: "manual" },
  });
}

// Pickup timestamps relative to today's MYT midnight, so "prior day" vs "today"
// is deterministic regardless of the wall clock the test runs at.
const DAY_START = () => mytDayStart(new Date());
const priorDayPickup = () => new Date(DAY_START().getTime() - 1000); // 1s before today 00:00 MYT
const todayPickup = () => new Date(DAY_START().getTime() + 6 * 60 * 60 * 1000); // today 06:00 MYT

async function setPickup(tripId: string, at: Date) {
  await prisma.trip.update({ where: { id: tripId }, data: { pickup_datetime: at } });
}
const fresh = (id: string) => prisma.trip.findUniqueOrThrow({ where: { id } });

describe("stale-ticket 3am sweep — cancel prior-day undelivered, free capacity", () => {
  beforeEach(async () => {
    await resetDb();
    await setManual();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("cancels a prior-day PENDING ticket", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["A2"], rt);
    await setPickup(trip.id, priorDayPickup());

    expect(await sweepStaleTickets()).toBeGreaterThanOrEqual(1);
    expect((await fresh(trip.id)).status).toBe("cancelled");
  });

  it("cancels a prior-day ASSIGNED ticket and frees the driver + truck", async () => {
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const trip = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, trip.id, driverId, PLX_PLATE);
    await setPickup(trip.id, priorDayPickup());
    expect((await fresh(trip.id)).status).toBe("assigned");

    await sweepStaleTickets();
    expect((await fresh(trip.id)).status).toBe("cancelled");

    // Capacity refreshed: the driver + truck are free, so a NEW booking assigns
    // to them without a busy/overloaded rejection (the guards key on status).
    const trip2 = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, trip2.id, driverId, PLX_PLATE);
    expect((await fresh(trip2.id)).status).toBe("assigned");
  });

  it("LEAVES a ticket scheduled for TODAY (not a prior-day leftover)", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["A2"], rt);
    await setPickup(trip.id, todayPickup());

    await sweepStaleTickets();
    expect((await fresh(trip.id)).status).toBe("pending"); // survives the 3am run
  });

  it("LEAVES an IN_PROGRESS trip — auto-abort is the admin's call, not the clock", async () => {
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const driver = await loginAs(DRIVER);
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const trip = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, trip.id, driverId, PLX_PLATE);
    await startTrip(driver, trip.id);
    await setPickup(trip.id, priorDayPickup());
    expect((await fresh(trip.id)).status).toBe("in_progress");

    await sweepStaleTickets();
    expect((await fresh(trip.id)).status).toBe("in_progress"); // untouched
  });

  it("LEAVES a completed trip (finished work is never cancelled)", async () => {
    // Build the completed trip directly (gate-agnostic: the terminal delivered
    // state — completed vs the approval gate — is item 9's concern, not item 8's).
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const trip = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, trip.id, driverId, PLX_PLATE);
    await prisma.trip.update({ where: { id: trip.id }, data: { status: "completed", pickup_datetime: priorDayPickup() } });
    expect((await fresh(trip.id)).status).toBe("completed");

    await sweepStaleTickets();
    expect((await fresh(trip.id)).status).toBe("completed"); // never touched
  });

  it("records a system 'cancelled' timeline event (actor null) explaining the auto-cancel", async () => {
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const trip = await bookTrip(requestor, ["A2"], rt);
    await setPickup(trip.id, priorDayPickup());

    await sweepStaleTickets();
    const ev = await prisma.tripStatusHistory.findFirst({
      where: { trip_id: trip.id, event: "cancelled" },
      orderBy: { created_at: "desc" },
    });
    expect(ev).toBeTruthy();
    expect(ev!.actor_id).toBeNull(); // system, not a user
    expect(ev!.note).toMatch(/auto-cancelled at 3am/i);
  });
});
