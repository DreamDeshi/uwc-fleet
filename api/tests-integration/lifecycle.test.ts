import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  approveIncentiveRaw,
  startTrip,
  arriveRaw,
  deliverRaw,
  userIdByPhone,
  num,
  DRIVERS,
} from "./helpers/flow";

/**
 * FULL-CHAIN LIFECYCLE (Phase 5) — one trip threaded through the ENTIRE
 * lifecycle via real HTTP, touching all three roles, and asserting the final
 * pay. This is the end-to-end proof that the pieces (each covered separately in
 * earlier phases) compose into one working flow — including the real `arrived`
 * HTTP transition, which the browser e2e bypasses by seeding the arrived state.
 *
 *   requestor:  book
 *   admin:      approve/assign (freezes the rate snapshot)
 *   driver:     start → arrived (real HTTP) → POD → delivered → completed
 *   → incentive finalized and asserted.
 */

const PLX_PLATE = DRIVERS.PLX.plate;

describe("FULL LIFECYCLE integration — book → assign → deliver → pay", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("threads a single A2 trip through every stage across all three roles", async () => {
    const [requestor, admin, driver] = await Promise.all([
      loginAs(REQUESTOR),
      loginAs(ADMIN),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(DRIVERS.PLX.phone);

    // ── REQUESTOR: book ──────────────────────────────────────────────────
    const trip = await bookTrip(requestor, ["A2"], rt); // Ipoh, 6 points
    expect(trip.status).toBe("pending");
    const stopId = trip.stops[0].id;
    // The owner can read their own booking back.
    const ownerRead = await api().get(`/api/v1/trips/${trip.id}`).set(auth(requestor));
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.status).toBe("pending");

    // ── ADMIN: approve/assign — freezes the rate snapshot onto the trip ───
    await approveTrip(admin, trip.id, plx, PLX_PLATE);
    const assigned = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(assigned.status).toBe("assigned");
    expect(assigned.driver_id).toBe(plx);
    expect(assigned.entitled_claim_weekday).not.toBeNull(); // snapshot taken

    // ── DRIVER: start ────────────────────────────────────────────────────
    await startTrip(driver, trip.id);
    expect((await prisma.trip.findUnique({ where: { id: trip.id } }))!.status).toBe("in_progress");

    // ── DRIVER: arrived — the REAL HTTP transition (e2e seeds this) ──────
    const arrived = await arriveRaw(driver, trip.id, stopId);
    expect(arrived.status).toBe(200);
    expect((await prisma.tripStop.findUnique({ where: { id: stopId } }))!.status).toBe("arrived");

    // ── DRIVER: POD + delivered → pending_approval + pay PROPOSED ────────
    // Under the POD-approval gate (16 Jul 2026) delivering the last stop no
    // longer completes the trip: it proposes the incentive and waits for admin
    // sign-off. The money is computed and frozen but NOT yet payable.
    await prisma.tripStop.update({
      where: { id: stopId },
      data: { pod_photo: "test://pod.jpg", do_uploaded: true },
    });
    const delivered = await deliverRaw(driver, trip.id, stopId);
    expect(delivered.status).toBe(200);

    const proposed = (await prisma.trip.findUnique({ where: { id: trip.id }, include: { stops: true } }))!;
    expect(proposed.status).toBe("pending_approval");
    expect(proposed.stops[0].status).toBe("delivered");
    expect(proposed.stops[0].delivered_at).not.toBeNull();
    expect(proposed.incentive_final).toBeNull(); // proposed, not yet payable

    // ── PAY (proposal): A2 (6pts) − PLX deduction (2) = 4 pts × snapshot rate ─
    const rate = num(proposed.rate_used);
    expect(proposed.stops[0].points_awarded).toBe(6);
    expect(proposed.deduction_applied).toBe(2);
    expect(num(proposed.incentive_earned)).toBeCloseTo((6 - 2) * rate, 2);
    if (proposed.off_peak === false) expect(num(proposed.incentive_earned)).toBe(44); // weekday-daytime

    // ── ADMIN: approve the POD → completed + incentive_final set (payable) ─
    const approveRes = await approveIncentiveRaw(admin, trip.id);
    expect(approveRes.status).toBe(200);
    const done = (await prisma.trip.findUnique({ where: { id: trip.id }, include: { stops: true } }))!;
    expect(done.status).toBe("completed");
    expect(num(done.incentive_final)).toBeCloseTo((6 - 2) * rate, 2); // approved == proposal
    expect(num(done.incentive_earned)).toBeCloseTo((6 - 2) * rate, 2); // proposal preserved
    expect(done.incentive_override_reason).toBeNull(); // not edited
    expect(done.incentive_approved_by).toBeTruthy();
    expect(done.incentive_approved_at).not.toBeNull();

    // ── The whole lifecycle is recorded in the status history ────────────
    const events = (
      await prisma.tripStatusHistory.findMany({
        where: { trip_id: trip.id },
        orderBy: { created_at: "asc" },
        select: { event: true },
      })
    ).map((e) => e.event);
    for (const e of [
      "booked",
      "assigned",
      "started",
      "stop_arrived",
      "stop_delivered",
      "incentive_approved",
      "completed",
    ]) {
      expect(events).toContain(e);
    }

    // ── Roles see the finished trip: driver's completed trip carries the pay ─
    const driverView = await api().get(`/api/v1/trips/${trip.id}`).set(auth(driver));
    expect(driverView.status).toBe(200);
    expect(driverView.body.status).toBe("completed");
    expect(num(driverView.body.incentive_earned)).toBeCloseTo((6 - 2) * rate, 2);
  });
});
