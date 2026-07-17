import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { prisma, resetDb, loginAs, api, auth, ADMIN, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, ensureConsigneeInZone, pallets } from "./helpers/flow";

/**
 * CAPACITY MUST BE DATE-SCOPED (Mr. Teh's trial bug, 16 Jul 2026).
 *
 * His repro: "I just run a test to arrange 17-July pickup 9am, and 16-July I
 * arrange another 4pm pickup but system mentioned the capacity is full …
 * for 16-July delivery, the cargo supposed empty because i have not yet
 * request any delivery."
 *
 * Root cause: three surfaces summed a truck's load over ALL assigned/
 * in_progress trips with no pickup-date scope, so a booking assigned for one
 * day consumed the truck's capacity (and its driver) on EVERY day:
 *   - autoDispatchTrip's driver filter + currentLoad (dispatchEngine.ts)
 *   - the manual-assign TRUCK_OVERLOADED hard block (assignTripInTx, trips.ts)
 *   - the GET /trucks card's current_load ("Idle · 0 trips today · Load 9/14")
 *
 * The rule now: an `in_progress` trip always blocks/counts (the cargo is
 * physically on the truck, the driver is out); an `assigned` trip blocks and
 * counts ONLY against bookings picked up on the SAME MYT day.
 *
 * 15 pallets of 4×4 fit ONLY PLX 2406 (16) — every other truck is ≤14 — so
 * each booking below has exactly one possible truck, making the assertions
 * deterministic.
 */

const BIG = pallets(15); // 15 × 4×4 = 15 equivalents → only PLX 2406 (16) fits

/** Pickup at 09:00/10:00 MYT `daysAhead` days from now — always bookable,
 *  always inside the 07:00–18:00 operating window. */
function pickupIso(daysAhead: number, hourMyt: number): string {
  const MYT_MS = 8 * 60 * 60 * 1000;
  const nowMyt = new Date(Date.now() + MYT_MS);
  const day = new Date(
    Date.UTC(nowMyt.getUTCFullYear(), nowMyt.getUTCMonth(), nowMyt.getUTCDate() + daysAhead, hourMyt) - MYT_MS
  );
  return day.toISOString();
}

/** The MYT "YYYY-MM-DD" key `daysAhead` days from now — what ?date= takes. */
function mytKeyDaysAhead(daysAhead: number): string {
  const MYT_MS = 8 * 60 * 60 * 1000;
  const nowMyt = new Date(Date.now() + MYT_MS);
  const d = new Date(
    Date.UTC(nowMyt.getUTCFullYear(), nowMyt.getUTCMonth(), nowMyt.getUTCDate() + daysAhead)
  );
  return d.toISOString().slice(0, 10);
}

async function bookBig(token: string, rt: string, daysAhead: number, hourMyt: number) {
  const c = await ensureConsigneeInZone("P1");
  const res = await api()
    .post("/api/v1/trips")
    .set(auth(token))
    .send({
      route_type_id: rt,
      pickup_datetime: pickupIso(daysAhead, hourMyt),
      stops: [{ consignee_id: c.id, sequence: 1 }],
      cargo_details: BIG,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string; truck_plate: string | null };
}

async function setMode(mode: "auto" | "manual"): Promise<void> {
  await prisma.appSetting.upsert({
    where: { id: "singleton" },
    update: { dispatch_mode: mode },
    create: { id: "singleton", dispatch_mode: mode },
  });
}

const freshTrip = (id: string) => prisma.trip.findUniqueOrThrow({ where: { id } });

describe("truck capacity is scoped to the pickup MYT day", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await setMode("manual");
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("AUTO: a booking assigned for TOMORROW does not consume the truck for the DAY AFTER (his 17-blocks-16 repro, generalised)", async () => {
    await setMode("auto");
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    // Day A: 15 pallets → only PLX fits → auto-assigns to PLX.
    const tripA = await bookBig(requestor, rt, 1, 9);
    expect((await freshTrip(tripA.id)).status).toBe("assigned");
    expect((await freshTrip(tripA.id)).truck_plate).toBe("PLX 2406");

    // Day B (a DIFFERENT MYT day): same 15-pallet order. Pre-fix, PLX's driver
    // was excluded (holds an assigned trip, any date) and PLX's currentLoad was
    // 15/16 — so dispatch failed with "no truck has capacity". The truck is
    // empty on day B; it must assign.
    const tripB = await bookBig(requestor, rt, 2, 10);
    const b = await freshTrip(tripB.id);
    expect(b.auto_dispatch_failed).toBe(false);
    expect(b.status).toBe("assigned");
    expect(b.truck_plate).toBe("PLX 2406");
  });

  it("MANUAL: assigning the same truck on a different day is not TRUCK_OVERLOADED", async () => {
    await setMode("manual");
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const rt = await firstRouteTypeId(requestor);

    const plxDriver = await prisma.user.findFirstOrThrow({
      where: { assigned_truck_plate: "PLX 2406" },
      select: { id: true },
    });

    const tripA = await bookBig(requestor, rt, 1, 9);
    const approveA = await api()
      .patch(`/api/v1/trips/${tripA.id}/approve`)
      .set(auth(admin))
      .send({ driver_id: plxDriver.id, truck_plate: "PLX 2406" });
    expect(approveA.status).toBe(200);

    // Same truck, next day: the 15 pallets from day A must not count.
    // (force covers the soft scheduling-conflict warning only — the overload
    // check is a hard 400 that force can NOT bypass, so a pass proves the
    // capacity itself is now date-scoped.)
    const tripB = await bookBig(requestor, rt, 2, 10);
    const approveB = await api()
      .patch(`/api/v1/trips/${tripB.id}/approve`)
      .set(auth(admin))
      .send({ driver_id: plxDriver.id, truck_plate: "PLX 2406", force: true });
    expect(approveB.status, JSON.stringify(approveB.body)).toBe(200);
    expect((await freshTrip(tripB.id)).status).toBe("assigned");
  });

  it("SAME DAY still blocks: two 15-pallet bookings on one day cannot both ride PLX", async () => {
    await setMode("auto");
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);

    const tripA = await bookBig(requestor, rt, 1, 9);
    expect((await freshTrip(tripA.id)).truck_plate).toBe("PLX 2406");

    // Second 15-pallet order the SAME day: PLX is committed that day, nothing
    // else fits → must NOT assign (needs-attention), same as before the fix.
    const tripB = await bookBig(requestor, rt, 1, 14);
    const b = await freshTrip(tripB.id);
    expect(b.status).toBe("pending");
    expect(b.truck_plate).toBeNull();
  });

  it("GET /trucks: current_load shows TODAY's commitment, not a future day's", async () => {
    await setMode("auto");
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const rt = await firstRouteTypeId(requestor);

    // Assigned for TOMORROW: today's card must not show it as load
    // (his screenshot: "Idle · 0 trips today" yet "Load 9/14").
    const trip = await bookBig(requestor, rt, 1, 9);
    expect((await freshTrip(trip.id)).truck_plate).toBe("PLX 2406");

    const res = await api().get("/api/v1/trucks").set(auth(admin));
    expect(res.status).toBe(200);
    const plx = res.body.find((t: { plate: string }) => t.plate === "PLX 2406");
    expect(plx.current_load).toBe(0);
  });

  /**
   * Item 7b (Mr. Teh, 17 Jul 2026): "let admin to select to show the cargo
   * capacity based on different date", and show the loading's ticket,
   * destination company and cargo. ?date= picks the MYT day; the detail is the
   * same trips the load bar already summed, no longer discarded.
   */
  it("GET /trucks?date=: the SAME booking is invisible today but loads its own day", async () => {
    await setMode("auto");
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const rt = await firstRouteTypeId(requestor);

    const trip = await bookBig(requestor, rt, 1, 9); // tomorrow
    expect((await freshTrip(trip.id)).truck_plate).toBe("PLX 2406");

    const plxOn = async (date?: string) => {
      const res = await api()
        .get(`/api/v1/trucks${date ? `?date=${date}` : ""}`)
        .set(auth(admin));
      expect(res.status).toBe(200);
      return res.body.find((t: { plate: string }) => t.plate === "PLX 2406");
    };

    // Today: nothing (the 16 Jul fix).
    expect((await plxOn(mytKeyDaysAhead(0))).current_load).toBe(0);
    expect((await plxOn(mytKeyDaysAhead(0))).current_loading).toEqual([]);

    // Tomorrow — the day it's actually booked for: the full 15 shows up. This
    // is the half his screenshot couldn't see at all; before ?date= the only
    // answerable question was "what's on it today".
    const tomorrow = await plxOn(mytKeyDaysAhead(1));
    expect(tomorrow.current_load).toBe(15);
    expect(tomorrow.current_loading).toHaveLength(1);

    // The day after: empty again — the scope is one day, not "today onwards".
    expect((await plxOn(mytKeyDaysAhead(2))).current_load).toBe(0);
  });

  it("GET /trucks?date=: each loading names its ticket, destination company and cargo", async () => {
    await setMode("auto");
    const requestor = await loginAs(REQUESTOR);
    const admin = await loginAs(ADMIN);
    const rt = await firstRouteTypeId(requestor);

    const trip = await bookBig(requestor, rt, 1, 9);
    const fresh = await freshTrip(trip.id);
    expect(fresh.truck_plate).toBe("PLX 2406");

    const res = await api().get(`/api/v1/trucks?date=${mytKeyDaysAhead(1)}`).set(auth(admin));
    const plx = res.body.find((t: { plate: string }) => t.plate === "PLX 2406");
    const [loading] = plx.current_loading;

    // (a) which ticket — the whole point of the ask; admin had to open the
    // Trips board to answer this before.
    expect(loading.ticket_number).toBe(fresh.ticket_number);
    expect(loading.ticket_number).toMatch(/^TKT-/);
    // (b) destination company name (not just the zone/area the card showed).
    const consignee = await ensureConsigneeInZone("P1");
    expect(loading.destination).toBe(consignee.company_name);
    // (c) cargo details.
    expect(loading.cargo).toEqual([
      expect.objectContaining({ pallet_type: "4×4", quantity: 15 }),
    ]);
    // (d) the date of the assignment's cargo.
    expect(loading.pickup_datetime).toBe(fresh.pickup_datetime.toISOString());
    // The entries must always reconcile with the bar above them.
    expect(loading.pallets).toBe(15);
    expect(
      plx.current_loading.reduce((s: number, l: { pallets: number }) => s + l.pallets, 0)
    ).toBe(plx.current_load);
  });

  it("GET /trucks: a malformed ?date= falls back to today rather than 400ing", async () => {
    const admin = await loginAs(ADMIN);
    const bad = await api().get("/api/v1/trucks?date=not-a-date").set(auth(admin));
    const today = await api().get("/api/v1/trucks").set(auth(admin));
    expect(bad.status).toBe(200);
    expect(bad.body.map((t: { plate: string; current_load: number }) => [t.plate, t.current_load])).toEqual(
      today.body.map((t: { plate: string; current_load: number }) => [t.plate, t.current_load])
    );
  });
});
