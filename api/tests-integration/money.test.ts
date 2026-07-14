import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  userIdByPhone,
  firstRouteTypeId,
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  stopsBySequence,
  num,
} from "./helpers/flow";
import { isOffPeak } from "../src/services/incentiveEngine";

/**
 * MONEY integration (Phase 1) — the finalize/ledger path exercised END-TO-END
 * through Postgres, not the in-memory re-implementation the unit tests use.
 *
 * These are robust to wall-clock: pay is asserted against the trip's OWN stored
 * snapshot rate (rate_used / entitled_claim_*), so a run during off-peak hours
 * still passes. The exact client figures (RM44 + RM11 = RM55) are asserted only
 * when the run happens to be weekday-daytime (off_peak === false).
 *
 * The seeded PLX 2406: weekday RM11 / off-peak RM13, daily deduction 2, only
 * A-zone truck. A2 (Ipoh) = 6 points, A1 (Taiping) = 5 points.
 */

const PLX_PLATE = "PLX 2406";

async function loginAll() {
  const [requestor, admin, driver] = await Promise.all([
    loginAs(REQUESTOR),
    loginAs(ADMIN),
    loginAs(DRIVER),
  ]);
  return { requestor, admin, driver };
}

describe("MONEY integration — finalize & day-ledger through Postgres", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("per-zone-per-day: two same-zone trips pay full then repeat (RM44 + RM11 = RM55 on a weekday)", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    // Trip 1 — A2 (6pts), the day's first drop → full 6 minus PLX deduction 2.
    const t1 = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t1.id, driverId, PLX_PLATE);
    await startTrip(driver, t1.id);
    await arriveAndDeliver(driver, t1.id, t1.stops[0].id);

    // Trip 2 — A2 again, same driver, same MYT day → REPEAT (1pt), no deduction.
    // (Trip 1 is already completed, so trip 2 assigns/starts without conflict.)
    const t2 = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t2.id, driverId, PLX_PLATE);
    await startTrip(driver, t2.id);
    await arriveAndDeliver(driver, t2.id, t2.stops[0].id);

    const trip1 = (await prisma.trip.findUnique({ where: { id: t1.id }, include: { stops: true } }))!;
    const trip2 = (await prisma.trip.findUnique({ where: { id: t2.id }, include: { stops: true } }))!;
    const rate1 = num(trip1.rate_used);
    const rate2 = num(trip2.rate_used);

    // Trip 1: full points, deduction taken, first-of-day.
    expect(trip1.stops[0].points_awarded).toBe(6);
    expect(trip1.stops[0].was_repeat).toBe(false);
    expect(trip1.deduction_applied).toBe(2);
    expect(num(trip1.incentive_earned)).toBeCloseTo((6 - 2) * rate1, 2);

    // Trip 2: same zone same day → 1 point, NO second deduction (the real
    // cross-trip ledger read from Postgres, not a stub, is what makes this 1).
    expect(trip2.stops[0].points_awarded).toBe(1);
    expect(trip2.stops[0].was_repeat).toBe(true);
    expect(trip2.deduction_applied).toBe(0);
    expect(num(trip2.incentive_earned)).toBeCloseTo(1 * rate2, 2);

    // Delivered seconds apart → same tier → same rate; the day sums to 5×rate.
    expect(rate1).toBe(rate2);
    const daySum = num(trip1.incentive_earned) + num(trip2.incentive_earned);
    expect(daySum).toBeCloseTo(5 * rate1, 2);

    // The exact client figure, when the run is weekday-daytime (peak).
    if (trip1.off_peak === false) {
      expect(num(trip1.incentive_earned)).toBe(44);
      expect(num(trip2.incentive_earned)).toBe(11);
      expect(daySum).toBe(55);
    }
  });

  it("midnight straddle: one trip whose drops fall on two MYT days sums each day's marginal", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    // 2-stop trip: A2 (6pts) then A1 (5pts) — both PLX-covered.
    const t = await bookTrip(requestor, ["A2", "A1"], rt);
    await approveTrip(admin, t.id, driverId, PLX_PLATE);
    await startTrip(driver, t.id);
    const [first, second] = stopsBySequence(t);

    // Deliver stop 1 (stamped now), then push its delivered_at back ~30h so the
    // finalize (triggered by stop 2) sees the trip straddling MYT midnight.
    await arriveAndDeliver(driver, t.id, first.id);
    const priorDay = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await prisma.tripStop.update({ where: { id: first.id }, data: { delivered_at: priorDay } });

    // Deliver stop 2 (stamped now) → finalize runs across TWO delivery-day groups.
    await arriveAndDeliver(driver, t.id, second.id);

    const trip = (await prisma.trip.findUnique({ where: { id: t.id }, include: { stops: true } }))!;
    const stopA2 = trip.stops.find((s) => s.zone_code === "A2")!;
    const stopA1 = trip.stops.find((s) => s.zone_code === "A1")!;

    // Multi-group markers: a trip spanning two tiers can't carry a single
    // trip-level rate/tier, so both are NULL; the deduction is each day's summed.
    expect(trip.rate_used).toBeNull();
    expect(trip.off_peak).toBeNull();
    expect(trip.deduction_applied).toBe(4); // 2 (prior day) + 2 (today)

    // Each drop is the first (and only) drop of its OWN day → full points, no repeat.
    expect(stopA2.points_awarded).toBe(6);
    expect(stopA2.was_repeat).toBe(false);
    expect(stopA1.points_awarded).toBe(5);
    expect(stopA1.was_repeat).toBe(false);

    // Total = Σ over days of (points − that day's deduction) × that day's tier
    // rate, using the trip's frozen snapshot rates + the SAME isOffPeak the
    // engine uses. This cross-checks the route's per-group summation + rounding.
    const snapWeekday = num(trip.entitled_claim_weekday);
    const snapOffpeak = num(trip.entitled_claim_offpeak);
    const holidays = new Set(
      (await prisma.publicHoliday.findMany({ select: { date: true } })).map((r) => r.date)
    );
    const rateFor = (at: Date) => (isOffPeak(at, holidays) ? snapOffpeak : snapWeekday);
    const expected =
      (6 - 2) * rateFor(stopA2.delivered_at!) + (5 - 2) * rateFor(stopA1.delivered_at!);
    expect(num(trip.incentive_earned)).toBeCloseTo(Math.round(expected * 100) / 100, 2);
  });

  it("rate lock: an in-flight trip finalizes at its assignment-time rate, immune to a mid-day edit", async () => {
    const { requestor, admin, driver } = await loginAll();
    const driverId = await userIdByPhone(DRIVER.phone);
    const rt = await firstRouteTypeId(requestor);

    const truckBefore = (await prisma.truck.findUnique({ where: { plate: PLX_PLATE } }))!;
    const preWeekday = num(truckBefore.entitled_claim_weekday); // 11
    const preOffpeak = num(truckBefore.entitled_claim_offpeak); // 13

    // Assignment freezes the truck's current rates onto the trip.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, PLX_PLATE);
    const snap = (await prisma.trip.findUnique({ where: { id: t.id } }))!;
    expect(num(snap.entitled_claim_weekday)).toBe(preWeekday);
    expect(num(snap.entitled_claim_offpeak)).toBe(preOffpeak);

    // Admin edits the rate mid-day via the real endpoint — it STAGES for the
    // next MYT day (client cutoff): today's live value must be unchanged.
    const patch = await api()
      .patch(`/api/v1/trucks/${encodeURIComponent(PLX_PLATE)}/rates`)
      .set(auth(admin))
      .send({ entitled_claim_weekday: preWeekday + 50, entitled_claim_offpeak: preOffpeak + 50 });
    expect(patch.status).toBe(200);
    const edited = (await prisma.truck.findUnique({ where: { plate: PLX_PLATE } }))!;
    expect(num(edited.entitled_claim_weekday)).toBe(preWeekday); // live UNCHANGED today
    expect(num(edited.pending_claim_weekday)).toBe(preWeekday + 50); // staged for tomorrow

    // Belt-and-braces: even a DIRECT live change must not move the in-flight
    // trip — it pays at its own frozen snapshot.
    await prisma.truck.update({
      where: { plate: PLX_PLATE },
      data: { entitled_claim_weekday: preWeekday + 99, entitled_claim_offpeak: preOffpeak + 99 },
    });

    await startTrip(driver, t.id);
    await arriveAndDeliver(driver, t.id, t.stops[0].id);

    const done = (await prisma.trip.findUnique({ where: { id: t.id }, include: { stops: true } }))!;
    const rateUsed = num(done.rate_used);
    const expectedRate = done.off_peak ? preOffpeak : preWeekday;
    expect(rateUsed).toBe(expectedRate); // the pre-edit snapshot, not +50 / +99
    expect([preWeekday + 50, preWeekday + 99, preOffpeak + 50, preOffpeak + 99]).not.toContain(rateUsed);
    expect(done.stops[0].points_awarded).toBe(6);
    expect(num(done.incentive_earned)).toBeCloseTo((6 - 2) * expectedRate, 2);
  });
});
