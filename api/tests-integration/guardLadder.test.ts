import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, loginAs, ADMIN, REQUESTOR, api, auth } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveRaw,
  approveTrip,
  userIdByPhone,
  pickupDateKey,
  pallets,
  DRIVERS,
  ensureConsigneeInZone,
  futurePickupIso,
} from "./helpers/flow";

/**
 * GUARD-LADDER integration (Phase 2) — the manual-approve guard ladder in
 * assignTripInTx, exercised through PATCH /trips/:id/approve + Postgres.
 *
 * Ladder order + force semantics (from the route):
 *   TRUCK_OVERLOADED     — physical overload; NEVER force-overridable
 *   TRUCK_UNROADWORTHY   — expired insurance/road tax; HARD, never forcible
 *   TRUCK_PERMIT_EXPIRED — expired permit; forcible → permit_expiry_override audit
 *   SCHEDULING_CONFLICT  — driver/truck double-book; forcible → assignment_conflict_override audit
 *   DRIVER_BUSY          — an in_progress trip elsewhere; never forcible
 *   DRIVER_ON_LEAVE      — leave covers pickup date; never forcible
 *   OPERATING_WINDOW     — run finishes past the window; forcible → operating_window_override audit
 */

const PND = DRIVERS.PND; // 16 pallets, roadworthy after each reset

async function ids() {
  const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
  const rt = await firstRouteTypeId(requestor);
  const plxDriver = await userIdByPhone(PND.phone);
  const prhDriver = await userIdByPhone(DRIVERS.PRH.phone);
  return { requestor, admin, rt, plxDriver, prhDriver };
}

describe("GUARD-LADDER integration — manual approve (assignTripInTx)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("TRUCK_OVERLOADED is NOT force-overridable", async () => {
    const { requestor, admin, rt, prhDriver } = await ids();
    // 3 pallets onto the 2-pallet PRH — a physical overload.
    const trip = await bookTrip(requestor, ["P1"], rt, pallets(3));
    const res = await approveRaw(admin, trip.id, prhDriver, DRIVERS.PRH.plate, true); // force = true
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TRUCK_OVERLOADED");
    expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.status).toBe("pending");
  });

  it("TRUCK_UNROADWORTHY (expired insurance) is a HARD block, even with force", async () => {
    const { requestor, admin, rt, plxDriver } = await ids();
    await prisma.truck.update({
      where: { plate: PND.plate },
      data: { insurance_expiry: new Date("2020-01-01T00:00:00Z") },
    });
    const trip = await bookTrip(requestor, ["P1"], rt);
    const res = await approveRaw(admin, trip.id, plxDriver, PND.plate, true); // force ignored
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TRUCK_UNROADWORTHY");
  });

  it("TRUCK_PERMIT_EXPIRED blocks without force, but force assigns + writes an audit row", async () => {
    const { requestor, admin, rt, plxDriver } = await ids();
    await prisma.truck.update({
      where: { plate: PND.plate },
      data: { permit_expiry: new Date("2020-01-01T00:00:00Z") }, // insurance/road tax stay valid
    });
    const trip = await bookTrip(requestor, ["P1"], rt);

    const blocked = await approveRaw(admin, trip.id, plxDriver, PND.plate, false);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TRUCK_PERMIT_EXPIRED");

    const forced = await approveRaw(admin, trip.id, plxDriver, PND.plate, true);
    expect(forced.status).toBe(200);
    expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.status).toBe("assigned");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "permit_expiry_override", record_id: { startsWith: trip.id } },
    });
    expect(audit).not.toBeNull();
  });

  it("SCHEDULING_CONFLICT blocks without force, but force assigns + writes an audit row", async () => {
    const { requestor, admin, rt, plxDriver } = await ids();
    // Two trips at the SAME pickup time to the SAME driver.
    const t1 = await bookTrip(requestor, ["P1"], rt);
    const t2 = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, t1.id, plxDriver, PND.plate); // first assigns cleanly

    const blocked = await approveRaw(admin, t2.id, plxDriver, PND.plate, false);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SCHEDULING_CONFLICT");

    const forced = await approveRaw(admin, t2.id, plxDriver, PND.plate, true);
    expect(forced.status).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "assignment_conflict_override", record_id: { startsWith: t2.id } },
    });
    expect(audit).not.toBeNull();
  });

  it("PATCHing dispatch.assignment_conflict_buffer_min changes whether two pickups conflict", async () => {
    // Phase 3 (28 Aug 2026) — the buffer is now admin-editable. This proves
    // the ROUTE actually reads the effective setting, not just that
    // findSchedulingConflicts accepts a bufferMs parameter in isolation.
    const { requestor, admin, rt, plxDriver } = await ids();
    const consignee = await ensureConsigneeInZone("P1");
    const basePickup = new Date(futurePickupIso());
    // 90 minutes later: inside the DEFAULT 120-min buffer, outside a 30-min one.
    const laterPickup = new Date(basePickup.getTime() + 90 * 60 * 1000);

    async function bookAt(pickup: Date) {
      const res = await api()
        .post("/api/v1/trips")
        .set(auth(requestor))
        .send({
          route_type_id: rt,
          pickup_datetime: pickup.toISOString(),
          stops: [{ consignee_id: consignee.id }],
          cargo_details: [{ pallet_type: "4×4", quantity: 1 }],
        });
      if (res.status !== 201) throw new Error(`book failed: ${res.status} ${res.text}`);
      return res.body as { id: string };
    }

    const t1 = await bookAt(basePickup);
    const t2 = await bookAt(laterPickup);
    await approveTrip(admin, t1.id, plxDriver, PND.plate);

    // At the DEFAULT buffer (120 min), a pickup 90 minutes later for the SAME
    // driver still conflicts.
    const blockedAtDefault = await approveRaw(admin, t2.id, plxDriver, PND.plate, false);
    expect(blockedAtDefault.status).toBe(409);
    expect(blockedAtDefault.body.error.code).toBe("SCHEDULING_CONFLICT");

    // An admin shrinks the buffer to 30 minutes.
    const patch = await api()
      .patch("/api/v1/settings/dispatch.assignment_conflict_buffer_min")
      .set(auth(admin))
      .send({ value: 30 });
    expect(patch.status).toBe(200);

    // The SAME two pickups, 90 minutes apart, no longer conflict under the
    // shrunk buffer.
    const allowedAfterShrink = await approveRaw(admin, t2.id, plxDriver, PND.plate, false);
    expect(allowedAfterShrink.status).toBe(200);
  });

  it("DRIVER_ON_LEAVE is NOT force-overridable", async () => {
    const { requestor, admin, rt, plxDriver } = await ids();
    await prisma.driverLeave.create({
      data: { driver_id: plxDriver, start_date: pickupDateKey(), end_date: pickupDateKey() },
    });
    const trip = await bookTrip(requestor, ["P1"], rt);

    const noForce = await approveRaw(admin, trip.id, plxDriver, PND.plate, false);
    expect(noForce.status).toBe(409);
    expect(noForce.body.error.code).toBe("DRIVER_ON_LEAVE");

    const forced = await approveRaw(admin, trip.id, plxDriver, PND.plate, true);
    expect(forced.status).toBe(409); // leave is physical unavailability — force can't override
    expect(forced.body.error.code).toBe("DRIVER_ON_LEAVE");
  });
});
