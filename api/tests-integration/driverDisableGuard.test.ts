import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, bookTrip, approveTrip, startTrip, userIdByPhone, DRIVERS } from "./helpers/flow";

/**
 * The 🔴 de-orphan fix: disabling a driver mid-trip used to strand the
 * in_progress trip (no admin reassign/complete path). Now the disable is guarded
 * (DRIVER_ON_ACTIVE_TRIP) and an admin-only PATCH /trips/:id/abort is the escape
 * hatch — in_progress → cancelled, which frees the truck and lets the driver be
 * disabled. No pay is finalized (money path untouched).
 *
 * Isolation: users aren't truncated by resetDb, so this suite re-activates the
 * PLX driver each run (it disables it) and on teardown.
 */
const PLX = DRIVERS.PLX;

async function reactivatePlx() {
  await prisma.user.update({ where: { phone: PLX.phone }, data: { status: "active" } }).catch(() => {});
}

describe("Disable guard + admin abort (in_progress de-orphan)", () => {
  beforeEach(async () => {
    await resetDb();
    await reactivatePlx();
  });
  afterAll(async () => {
    await reactivatePlx();
    await prisma.$disconnect();
  });

  async function startedTrip() {
    const [admin, requestor, driver] = await Promise.all([loginAs(ADMIN), loginAs(REQUESTOR), loginAs(DRIVER)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id); // → in_progress
    return { admin, requestor, driver, plx, trip };
  }

  it("refuses to disable a driver out on an in_progress trip", async () => {
    const { admin, plx } = await startedTrip();
    const res = await api().patch(`/api/v1/users/${plx}/approve`).set(auth(admin)).send({ status: "disabled" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DRIVER_ON_ACTIVE_TRIP");
    // The driver is still active — not half-disabled.
    const u = await prisma.user.findUnique({ where: { id: plx } });
    expect(u!.status).toBe("active");
  });

  it("a scheduled (assigned, not started) trip does NOT block disabling — it's reassignable", async () => {
    const [admin, requestor] = await Promise.all([loginAs(ADMIN), loginAs(REQUESTOR)]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const trip = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate); // assigned, NOT started
    const res = await api().patch(`/api/v1/users/${plx}/approve`).set(auth(admin)).send({ status: "disabled" });
    expect(res.status).toBe(200);
  });

  it("admin abort → cancelled (no pay finalized) → the driver can then be disabled", async () => {
    const { admin, plx, trip } = await startedTrip();

    const abort = await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(admin)).send({ reason: "driver departed" });
    expect(abort.status).toBe(200);
    expect(abort.body.status).toBe("cancelled");

    // Money path untouched: an aborted trip never finalizes an incentive.
    const t = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(t!.incentive_earned).toBeNull();
    // A cancelled trip is timeline-logged.
    const evt = await prisma.tripStatusHistory.findFirst({ where: { trip_id: trip.id, event: "cancelled" } });
    expect(evt).toBeTruthy();

    // With no in_progress trip, the disable now succeeds.
    const disable = await api().patch(`/api/v1/users/${plx}/approve`).set(auth(admin)).send({ status: "disabled" });
    expect(disable.status).toBe(200);
    expect(disable.body.status).toBe("disabled");
  });

  it("abort is admin-only and in_progress-only", async () => {
    const { admin, requestor, driver, trip } = await startedTrip();

    // Non-admins are refused before any state check.
    expect((await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(requestor)).send({})).status).toBe(403);
    expect((await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(driver)).send({})).status).toBe(403);

    // A not-yet-assigned booking can't be aborted (use cancel) → 400 INVALID_STATUS.
    const rt = await firstRouteTypeId(requestor);
    const pending = await bookTrip(requestor, ["P1"], rt);
    const res = await api().patch(`/api/v1/trips/${pending.id}/abort`).set(auth(admin)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");

    // The still-in_progress trip is untouched by all the rejected attempts.
    const t = await prisma.trip.findUnique({ where: { id: trip.id } });
    expect(t!.status).toBe("in_progress");
  });
});
