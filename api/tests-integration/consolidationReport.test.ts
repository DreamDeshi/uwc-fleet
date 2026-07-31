import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The all-vetoed fixture at the bottom of this file reports an exception, which
// uploads photo evidence. Same stub as moneyEndToEnd.test.ts.
vi.mock("../src/lib/cloudinary", () => ({
  uploadBuffer: vi.fn(async (_b: Buffer, folder: string) => ({
    url: `https://res.cloudinary.test/${folder}/authenticated`,
    publicId: `${folder}/pub_${randomUUID()}`,
    resourceType: "image",
    format: "jpg",
  })),
  isCloudinaryConfigured: () => true,
  cloudinary: { url: (id: string) => `https://res.cloudinary.test/signed/${id}` },
}));

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import {
  bookTrip,
  approveTrip,
  startTrip,
  arriveAndDeliver,
  approveIncentive,
  firstRouteTypeId,
  userIdByPhone,
  stopsBySequence,
  DRIVERS,
  type FlowTrip,
} from "./helpers/flow";

/**
 * GET /reports/consolidation — THE SUSTAINABILITY NUMBERS THE ADMIN PUBLISHES.
 *
 * Both halves of this endpoint's maths already had unit tests
 * (tests/consolidationSavings.test.ts, tests/rightSizingSavings.test.ts). The
 * ROUTE had none — nothing checked that it feeds those pure functions the right
 * ROWS. That is precisely the gap the last three audits kept finding: the
 * arithmetic was never wrong, the threading was (payroll month bucketing, the
 * CSV export join, the four "this month" surfaces).
 *
 * The endpoint returns two savings figures computed over DELIBERATELY DIFFERENT
 * SETS, in one JSON object, and that is the thing most likely to be "tidied" by
 * a future reader:
 *
 *   consolidation (trips/drops/tripsSaved/estKm/estLitres/estCo2e)
 *       ALL completed trips, SINCE LAUNCH, cumulative. INTERNAL FLEET ONLY.
 *   rightSizing
 *       completed INTERNAL trips with a truck, picked up THIS MYT MONTH.
 *
 * Every one of those clauses is pinned below by data that only that clause
 * excludes, so making the two agree — in either direction — goes red.
 */
describe("GET /reports/consolidation", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";

  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  /** Book → assign → start → deliver every stop → approve. Reaches `completed`. */
  async function completedTrip(zones: string[]): Promise<FlowTrip> {
    const trip = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, trip.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, trip.id);
    for (const stop of stopsBySequence(trip)) {
      await arriveAndDeliver(driver, trip.id, stop.id);
    }
    await approveIncentive(admin, trip.id);
    const after = await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } });
    expect(after!.status, "the fixture never reached completed").toBe("completed");
    return trip;
  }

  const get = async (token: string) => {
    const res = await api().get("/api/v1/reports/consolidation").set(auth(token));
    expect(res.status, res.text).toBe(200);
    return res.body as {
      trips: number; drops: number; tripsSaved: number;
      estKmSaved: number; estLitresSaved: number; estCo2eKgSaved: number;
      rightSizing: { trips: number; tripsRightSized: number; estLitresSaved: number; estCo2eKgSaved: number };
    };
  };

  it("is admin-only — a driver and a requestor cannot read it", async () => {
    for (const [who, token] of [["driver", driver], ["requestor", requestor]] as const) {
      const res = await api().get("/api/v1/reports/consolidation").set(auth(token));
      expect(res.status, `${who} got ${res.status}`).toBe(403);
    }
    const anon = await api().get("/api/v1/reports/consolidation");
    expect(anon.status).toBe(401);
  });

  it("counts drops and trips from the rows, and only from COMPLETED ones", async () => {
    // Two completed trips, 3 drops + 1 drop = 4 drops in 2 trips → 2 saved.
    await completedTrip(["P1", "P2", "P3"]);
    await completedTrip(["K1"]);

    // A trip left IN PROGRESS, and a trip still PENDING. Neither has finished,
    // so neither has saved anybody a journey yet. Without the status filter
    // these add 3 trips / 5 drops and every figure below is wrong.
    const running = await bookTrip(requestor, ["A1", "A2"], rt);
    await approveTrip(admin, running.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, running.id);
    await bookTrip(requestor, ["K2", "P1", "P2"], rt);

    const body = await get(admin);
    expect(body.trips).toBe(2);
    expect(body.drops).toBe(4);
    expect(body.tripsSaved).toBe(2);
  });

  it("turns trips saved into the km/litres/CO2e the screen prints", async () => {
    await completedTrip(["P1", "P2", "P3"]); // 3 drops, 1 trip → 2 saved

    const body = await get(admin);
    expect(body.tripsSaved).toBe(2);
    // The defaults in lib/consolidationSavings: 35 km per avoided delivery,
    // 30 L/100km, 2.68 kg CO2e per litre. Pinned through the ROUTE, so a
    // caller that stopped passing the default config (or passed the
    // right-sizing one, which shares two of the three names) goes red here.
    expect(body.estKmSaved).toBe(70);
    expect(body.estLitresSaved).toBe(21);
    expect(body.estCo2eKgSaved).toBe(56.28);
  });

  it("a trip aborted after one drop claims ONE delivery, not its whole itinerary", async () => {
    // THE BUG THIS FILE WAS WRITTEN FOR, and it needs no feature flag.
    //
    // Three stops booked. The driver delivers the first, the lorry breaks down,
    // the admin aborts. Partial pay sends the trip to `pending_approval` with
    // the two unreached stops left `pending`, and approving it makes the trip
    // `completed` — carrying stops nobody ever drove to.
    //
    // Counting the ITINERARY (Trip._count.stops, what the route did) reported
    // 3 drops in 1 trip: two avoided journeys, 70 km and 56.28 kg of CO2e that
    // never happened, published under a heading that calls the trip count EXACT.
    const trip = await bookTrip(requestor, ["A2", "P1", "P2"], rt);
    await approveTrip(admin, trip.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, trip.id);
    const [first] = stopsBySequence(trip);
    await arriveAndDeliver(driver, trip.id, first.id);

    const abort = await api()
      .patch(`/api/v1/trips/${trip.id}/abort`)
      .set(auth(admin))
      .send({ reason: "lorry breakdown after the first drop" });
    expect(abort.status, abort.text).toBe(200);
    expect(abort.body.status).toBe("pending_approval");
    await approveIncentive(admin, trip.id);

    // The state that makes this reachable: a COMPLETED trip holding stops that
    // were never delivered and never even reached.
    const stops = await prisma.tripStop.findMany({
      where: { trip_id: trip.id },
      select: { status: true, arrived_at: true },
    });
    expect(stops.filter((s) => s.status === "delivered")).toHaveLength(1);
    expect(stops.filter((s) => s.status !== "delivered" && s.arrived_at === null)).toHaveLength(2);

    const body = await get(admin);
    expect(body.drops, "undelivered stops are being counted as deliveries").toBe(1);
    expect(body.trips).toBe(1);
    expect(body.tripsSaved, "one delivery cannot have saved a journey").toBe(0);
    expect(body.estKmSaved).toBe(0);
    expect(body.estCo2eKgSaved).toBe(0);
  });

  it("a cancelled trip's drops are not savings", async () => {
    const trip = await bookTrip(requestor, ["P1", "P2"], rt);
    const cancelled = await api()
      .patch(`/api/v1/trips/${trip.id}/cancel`)
      .set(auth(admin))
      .send({ reason: "audit fixture" });
    expect(cancelled.status, cancelled.text).toBe(200);
    const after = await prisma.trip.findUnique({ where: { id: trip.id }, select: { status: true } });
    expect(after!.status).toBe("cancelled");

    const body = await get(admin);
    expect(body.trips).toBe(0);
    expect(body.drops).toBe(0);
    expect(body.tripsSaved).toBe(0);
    expect(body.estCo2eKgSaved).toBe(0);
  });

  it("consolidation is CUMULATIVE but right-sizing is THIS MONTH — deliberately", async () => {
    // One completed trip, backdated to last month. The consolidation half has
    // no date bound by design (it is a since-launch total); the right-sizing
    // half is explicitly the running month and must drop it.
    //
    // This is the assertion that stops someone "harmonising" the two halves in
    // either direction, having noticed they disagree.
    const trip = await completedTrip(["P1", "P2"]);
    const lastMonth = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await prisma.trip.update({ where: { id: trip.id }, data: { pickup_datetime: lastMonth } });

    const body = await get(admin);
    expect(body.trips, "consolidation must NOT be month-scoped").toBe(1);
    expect(body.drops).toBe(2);
    expect(body.tripsSaved).toBe(1);
    expect(body.rightSizing.trips, "right-sizing must BE month-scoped").toBe(0);
    expect(body.rightSizing.tripsRightSized).toBe(0);
    expect(body.rightSizing.estLitresSaved).toBe(0);
  });

  it("an OUTSOURCED trip's drops are not our fleet's savings", async () => {
    // ⚠ CONSTRUCTED STATE, AND DELIBERATELY SO. `is_external` trips cannot
    // reach `completed` through the API today: the only writer of that status
    // is approveTripIncentiveOnce, reachable only from `pending_approval`,
    // which only the driver delivery path writes — and an outsourced trip has
    // no driver. So this is LATENT, not observed.
    //
    // It is still pinned, because the endpoint publishes fuel and CO2e figures
    // attributed to UWC's own fleet (the hero numbers beside it come from UWC
    // fuel logs, and rightSizing in this very response already filters
    // `is_external: false`). A forwarder's diesel is not ours to claim, and the
    // day someone adds "admin marks the forwarder's job done" this would start
    // over-claiming silently — which is exactly how nobody would notice.
    const ours = await completedTrip(["P1", "P2", "P3"]);
    const theirs = await completedTrip(["A1", "A2"]);
    await prisma.trip.update({ where: { id: theirs.id }, data: { is_external: true } });

    const body = await get(admin);
    expect(body.trips, "the outsourced trip is still being counted").toBe(1);
    expect(body.drops).toBe(3);
    expect(body.tripsSaved).toBe(2);
    // And the internal one is definitely still there.
    const kept = await prisma.trip.findUnique({ where: { id: ours.id }, select: { is_external: true } });
    expect(kept!.is_external).toBe(false);
  });

  /**
   * A COMPLETED TRIP THAT DELIVERED NOTHING must not sit in the denominator.
   *
   * `tripsSaved = drops − trips`, so a trip contributing 0 drops and 1 trip
   * SUBTRACTS a journey somebody really did save. The aggregate floor at zero
   * hides it whenever the total is small, which is exactly why this needs a
   * second, genuinely-consolidated trip alongside it: the damage is a total
   * that is quietly one too low, not an obviously broken zero.
   *
   * Reaching the state needs FEATURE_EXCEPTIONS — the all-vetoed trip that
   * finalizes at RM0 (PR #58). The flag is unset on production, so this is the
   * flag-ON world, which is the one CI's browser suite runs and the one the
   * owner is about to switch on.
   */
  describe("a completed trip that delivered nothing (FEATURE_EXCEPTIONS)", () => {
    const PHOTO = Buffer.from("fake-jpeg-bytes");
    beforeAll(() => { process.env.FEATURE_EXCEPTIONS = "true"; });
    afterAll(() => { delete process.env.FEATURE_EXCEPTIONS; });

    it("is excluded from the trip count, so it cannot cancel a real saving", async () => {
      // Trip A: three drops actually delivered → 2 journeys genuinely avoided.
      await completedTrip(["P1", "P2", "P3"]);

      // Trip B: one stop, reached, reported, REJECTED then re-reported and
      // verified+resumed. Reject beats approval, so it earns RM0 and finalizes.
      const b = await bookTrip(requestor, ["A2"], rt);
      await approveTrip(admin, b.id, driverId, DRIVERS.PND.plate);
      await startTrip(driver, b.id);
      const stop = b.stops[0].id;
      expect((await api().patch(`/api/v1/trips/${b.id}/status`).set(auth(driver))
        .send({ action: "arrived", stop_id: stop })).status).toBe(200);

      const report = async () => {
        const r = api().post(`/api/v1/trips/${b.id}/exception`).set(auth(driver));
        for (const [k, v] of Object.entries({
          category: "customer_site", reason: "Gate locked",
          client_occurrence_id: randomUUID(), client_action_id: randomUUID(),
          client_evidence_id: randomUUID(), trip_stop_id: stop,
        })) r.field(k, v as string);
        const res = await r.attach("photo", PHOTO, "e.jpg");
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.exception.id as string;
      };
      const act = (exId: string, what: string, body: Record<string, unknown> = {}) =>
        api().post(`/api/v1/trips/${b.id}/exception/${exId}/${what}`).set(auth(admin))
          .send({ client_action_id: randomUUID(), ...body });

      const bad = await report();
      expect((await act(bad, "reject", { note: "not a genuine failure" })).status).toBe(200);
      const good = await report();
      expect((await act(good, "verify")).status).toBe(200);
      expect((await act(good, "resume")).status).toBe(200);
      await approveIncentive(admin, b.id);

      // The state under test: completed, and not one delivered stop on it.
      const bAfter = await prisma.trip.findUnique({
        where: { id: b.id },
        select: { status: true, stops: { select: { status: true } } },
      });
      expect(bAfter!.status).toBe("completed");
      expect(bAfter!.stops.every((s) => s.status !== "delivered")).toBe(true);

      const body = await get(admin);
      expect(body.drops).toBe(3);
      expect(body.trips, "the trip that delivered nothing is in the denominator").toBe(1);
      expect(body.tripsSaved, "trip A's two saved journeys have been eaten").toBe(2);
    });
  });
});
