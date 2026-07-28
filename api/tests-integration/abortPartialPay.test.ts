import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, prisma, resetDb, loginAs, auth, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  approveIncentive,
  stopsBySequence,
  userIdByPhone,
  num,
  DRIVERS,
} from "./helpers/flow";

/**
 * Partial pay on admin abort — Mr. Teh, 28 Jul 2026 (WhatsApp, verbatim in
 * CLIENT_ANSWERS.md): admin cancels mid-trip after 3/5 stops delivered →
 * "yes keep the pay for those 3."
 *
 * Design under test: an abort with ≥1 delivered stop does NOT cancel outright —
 * it scores the DELIVERED stops exactly as a full delivery would (same engine,
 * same per-zone-per-day ledger, same snapshots) and flips the trip
 * in_progress → pending_approval, the same POD-approval lane a fully-delivered
 * trip takes; approval → completed sets the payable incentive_final. Undelivered
 * stops are never scored and keep their pending/arrived status. An abort with
 * ZERO delivered stops keeps the original behaviour (cancelled, no pay) —
 * pinned by driverDisableGuard.test.ts.
 */
const PLX = DRIVERS.PLX;

describe("Admin abort with delivered stops — partial pay (28 Jul 2026)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A started 2-stop PLX trip: stop 1 → A2 (Ipoh, 6 pts), stop 2 → P1. */
  async function startedTwoStopTrip() {
    const [admin, requestor, driver] = await Promise.all([
      loginAs(ADMIN),
      loginAs(REQUESTOR),
      loginAs(DRIVER),
    ]);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const trip = await bookTrip(requestor, ["A2", "P1"], rt);
    await approveTrip(admin, trip.id, plx, PLX.plate);
    await startTrip(driver, trip.id);
    const [stopA2, stopP1] = stopsBySequence(trip);
    return { admin, requestor, driver, trip, stopA2, stopP1 };
  }

  it("1/2 delivered → pending_approval, pay proposed for the delivered stop ONLY; approval completes and pays it", async () => {
    const { admin, driver, trip, stopA2, stopP1 } = await startedTwoStopTrip();

    await arriveAndDeliver(driver, trip.id, stopA2.id);

    const abort = await api()
      .patch(`/api/v1/trips/${trip.id}/abort`)
      .set(auth(admin))
      .send({ reason: "lorry breakdown after first drop" });
    expect(abort.status).toBe(200);
    // NOT cancelled: the delivered stop's pay is held for approval.
    expect(abort.body.status).toBe("pending_approval");

    const t = (await prisma.trip.findUnique({ where: { id: trip.id }, include: { stops: true } }))!;
    // The proposal covers the DELIVERED stop only: Ipoh (A2) = 6 points, the
    // PLX daily deduction (2) applied once → (6 − 2) × rate. The tier (weekday
    // 11 / off-peak 13) depends on the wall clock, so assert against the
    // rate_used the finalize itself recorded rather than re-deriving it.
    expect(t.incentive_earned).not.toBeNull();
    expect(t.rate_used).not.toBeNull();
    expect([11, 13]).toContain(num(t.rate_used));
    expect(num(t.deduction_applied)).toBe(2);
    expect(num(t.incentive_earned)).toBe((6 - 2) * num(t.rate_used));

    const a2 = t.stops.find((s) => s.id === stopA2.id)!;
    const p1 = t.stops.find((s) => s.id === stopP1.id)!;
    expect(a2.status).toBe("delivered");
    expect(num(a2.points_awarded)).toBe(6);
    expect(a2.was_repeat).toBe(false);
    // The undelivered stop was never scored and keeps its truthful status.
    expect(p1.status).toBe("pending");
    expect(p1.points_awarded).toBeNull();

    // The abort is history-logged as a cancellation with the partial-pay note.
    const evt = await prisma.tripStatusHistory.findFirst({
      where: { trip_id: trip.id, event: "cancelled" },
    });
    expect(evt).toBeTruthy();
    expect(evt!.note).toContain("1/2");

    // Normal approval lane: approve → completed, proposal becomes payable.
    const approved = await approveIncentive(admin, trip.id);
    expect(approved.status).toBe("completed");
    expect(num(approved.incentive_final)).toBe(num(t.incentive_earned));
  });

  it("admin may edit the amount at approval (reason required) — same rules as a full delivery", async () => {
    const { admin, driver, trip, stopA2 } = await startedTwoStopTrip();
    await arriveAndDeliver(driver, trip.id, stopA2.id);
    await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(admin)).send({});

    // Edit without a reason is refused; with a reason it lands as the final.
    const noReason = await api()
      .patch(`/api/v1/trips/${trip.id}/approve-incentive`)
      .set(auth(admin))
      .send({ final_amount: 10 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("REASON_REQUIRED");

    const edited = await approveIncentive(admin, trip.id, {
      final_amount: 10,
      reason: "partial run — adjusted per ops",
    });
    expect(edited.status).toBe("completed");
    expect(num(edited.incentive_final)).toBe(10);
  });

  it("abort after ALL stops delivered still loses — a delivered trip is resolved by approval, not abort", async () => {
    const { admin, driver, trip, stopA2, stopP1 } = await startedTwoStopTrip();
    await arriveAndDeliver(driver, trip.id, stopA2.id);
    await arriveAndDeliver(driver, trip.id, stopP1.id); // → pending_approval

    const res = await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(admin)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_STATUS");

    const t = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(t.status).toBe("pending_approval");
  });

  it("presentation pass (H1): /track says Partially delivered; completed-count KPI excludes the partial trip", async () => {
    const { admin, requestor, driver, trip, stopA2 } = await startedTwoStopTrip();
    await arriveAndDeliver(driver, trip.id, stopA2.id);
    await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(admin)).send({});
    await approveIncentive(admin, trip.id); // → completed, 1/2 stops delivered

    // The public tracking page must not claim "Delivered" for a booking whose
    // second stop never happened — the recipient reads it to know what arrived.
    const { url } = (
      await api().get(`/api/v1/trips/${trip.id}/tracking-link`).set(auth(requestor))
    ).body as { url: string };
    const token = url.slice(url.lastIndexOf("/track/") + "/track/".length);
    const page = await api().get(`/track/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Partially delivered");
    expect(page.text).toContain("1 / 2");

    // completed_today counts FULLY delivered trips only. Pull the trip into
    // today's pickup window first (bookTrip books tomorrow) so the exclusion
    // is real, not vacuous.
    await prisma.trip.update({ where: { id: trip.id }, data: { pickup_datetime: new Date() } });
    const before = await api().get("/api/v1/reports/dashboard").set(auth(admin));
    expect(before.body.completed_today).toBe(0);

    // A genuinely full delivery still counts.
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const full = await bookTrip(requestor, ["P1"], rt);
    await approveTrip(admin, full.id, plx, PLX.plate);
    await startTrip(driver, full.id);
    await arriveAndDeliver(driver, full.id, stopsBySequence(full)[0].id);
    await approveIncentive(admin, full.id);
    await prisma.trip.update({ where: { id: full.id }, data: { pickup_datetime: new Date() } });

    const after = await api().get("/api/v1/reports/dashboard").set(auth(admin));
    expect(after.body.completed_today).toBe(1);
  });

  it("the truck and driver free for dispatch after a partial abort (no capacity leak)", async () => {
    const { admin, driver, trip, stopA2 } = await startedTwoStopTrip();
    await arriveAndDeliver(driver, trip.id, stopA2.id);
    await api().patch(`/api/v1/trips/${trip.id}/abort`).set(auth(admin)).send({});

    // The same driver+truck can immediately take a fresh assignment — the
    // pending_approval trip no longer occupies them (same as a completed one).
    const requestor = await loginAs(REQUESTOR);
    const rt = await firstRouteTypeId(requestor);
    const plx = await userIdByPhone(PLX.phone);
    const next = await bookTrip(requestor, ["P1"], rt);
    const assigned = await approveTrip(admin, next.id, plx, PLX.plate);
    expect(assigned.status).toBe("assigned");
  });
});
