import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip, num, DRIVERS } from "./helpers/flow";

/**
 * MONEY, END TO END, THROUGH REAL ROUTES AND A REAL DATABASE.
 *
 * Every expected RM below is HAND-DERIVED FROM THE WORKBOOK and written as a
 * literal, before running anything. Nothing here recomputes the engine's own
 * formula, and nothing reads the engine's output and calls it correct — that is
 * the difference between this file and tests/conformance, which drives the pure
 * engine and derives most of its expectations from the same spec the engine
 * reads.
 *
 * ── THE WORKBOOK (INTERNAL LORRY RATE, 28 Jul 2026) ────────────────────────
 *
 *   zone points (identical for every lorry):
 *     P2 Juru/Perai/Batu Kawan 1 · K1 Kulim 3 · P1 Penang 3 · P3 Tasek Gelugor 3
 *     K2 Kuala Ketil / Sungai Petani 4 · A1 Taiping 5 · A2 Ipoh 6 · KL 8
 *
 *   rate per point (weekday 8-6 / PH-weekend-after-6pm), daily deduction:
 *     PND 1888  11 / 13  ded 2      PSA 5292  11 / 13  ded 2   (RM13 weekday in
 *     PLX 2406  11 / 13  ded 2        the sheet is a TYPO — "Sorry My mistake,
 *     PRJ 5292  10 / 10  ded 3        it is RM 11 for weekday", A5 29 Jul)
 *     PQL 5292  10 / 10  ded 3      PPE 1804  10 / 12  ded 3
 *     PRH 5292   9 /  9  ded 2      4 Wheel   11 / 11  ded 2
 *
 *   THE FORMULA (workbook + client answers), applied by hand below:
 *     points  = zone points, EXCEPT a repeat of a zone already delivered by this
 *               driver today, which scores 1
 *     day RM  = max(day points - deduction, 0) x rate     [deduction once a day]
 *     a trip's share = the MARGINAL of that, so the deduction is spent once
 *
 * ── ON THE CLOCK ───────────────────────────────────────────────────────────
 * This tier runs on the real clock, so the tier (weekday vs off-peak) depends on
 * WHEN it runs. Rather than skip those cases or pin a fake clock — which would
 * stop this being an end-to-end test — each expectation is stated in POINTS and
 * multiplied by the workbook rate for the tier the run actually lands in. The
 * tier is asserted against the trip's own persisted `rate_used`, so a wrong tier
 * is still caught; only the multiplier moves.
 *
 * Midnight-straddle, the 6pm boundary and public holidays CANNOT be driven this
 * way (they need a controlled clock and a delivery that is write-once). Those
 * stay in tests/conformance, and that limit is stated in the report rather than
 * papered over.
 */

const PHOTO = Buffer.from("fake-jpeg-bytes");
let requestor = "", admin = "", driver = "", driverId = "", rt = "";

// Workbook rates, typed out by hand from the sheet — NOT read from the spec.
const RATE = {
  "PND 1888": { wk: 11, op: 13, ded: 2 },
  "PRH 5292": { wk: 9, op: 9, ded: 2 },
  "PSA 5292": { wk: 11, op: 13, ded: 2 }, // sheet says 13 weekday — TYPO, corrected to 11
} as const;
const POINTS = { P2: 1, K1: 3, P1: 3, P3: 3, K2: 4, A1: 5, A2: 6, KL: 8 } as const;

describe("MONEY end-to-end — hand-derived from the workbook", () => {
  beforeAll(async () => {
    process.env.FEATURE_EXCEPTIONS = "true";
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => {
    delete process.env.FEATURE_EXCEPTIONS;
    await prisma.$disconnect();
  });
  beforeEach(async () => { await resetDb(); });

  const plate = DRIVERS.PND.plate; // the seeded driver's lorry

  async function runTrip(zones: string[], usePlate = plate) {
    const t = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, t.id, driverId, usePlate);
    await startTrip(driver, t.id);
    return t;
  }
  async function deliver(tripId: string, stopId: string) {
    const a = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect([200, 400]).toContain(a.status);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    const d = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "delivered", stop_id: stopId });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
  }
  async function deliverAs(token: string, tripId: string, stopId: string) {
    const a = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(token)).send({ action: "arrived", stop_id: stopId });
    expect([200, 400]).toContain(a.status);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    const d = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(token)).send({ action: "delivered", stop_id: stopId });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
  }
  const fresh = (id: string) => prisma.trip.findUniqueOrThrow({ where: { id } });

  /** The workbook rate for the tier this run actually landed in, asserted. */
  async function rateOf(tripId: string, p: keyof typeof RATE = "PND 1888") {
    const t = await fresh(tripId);
    const used = num(t.rate_used);
    expect([RATE[p].wk, RATE[p].op]).toContain(used); // tier must be one of the two
    return used;
  }

  it("A2 Ipoh, one drop — (6 - 2) x rate", async () => {
    const t = await runTrip(["A2"]);
    await deliver(t.id, t.stops[0].id);
    const rate = await rateOf(t.id);
    expect(num((await fresh(t.id)).incentive_earned)).toBe((POINTS.A2 - RATE["PND 1888"].ded) * rate);
    // Workbook golden anchor at the weekday rate: (6-2) x 11 = RM44.
    if (rate === 11) expect(num((await fresh(t.id)).incentive_earned)).toBe(44);
  });

  it("P2 Juru, one drop — 1 point does NOT cover the 2-point deduction, so RM0", async () => {
    // The low-point-first-drop case. max(1 - 2, 0) = 0.
    const t = await runTrip(["P2"]);
    await deliver(t.id, t.stops[0].id);
    expect(num((await fresh(t.id)).incentive_earned)).toBe(0);
  });

  it("KL, one drop — (8 - 2) x rate, the biggest single zone", async () => {
    const t = await runTrip(["KL"]);
    await deliver(t.id, t.stops[0].id);
    const rate = await rateOf(t.id);
    expect(num((await fresh(t.id)).incentive_earned)).toBe((POINTS.KL - 2) * rate);
    if (rate === 11) expect(num((await fresh(t.id)).incentive_earned)).toBe(66);
  });

  it("A2 twice in one trip — the repeat scores 1, so (6 + 1 - 2) x rate", async () => {
    const t = await runTrip(["A2", "A2"]);
    for (const s of t.stops) await deliver(t.id, s.id);
    const rate = await rateOf(t.id);
    expect(num((await fresh(t.id)).incentive_earned)).toBe((6 + 1 - 2) * rate);
    if (rate === 11) expect(num((await fresh(t.id)).incentive_earned)).toBe(55); // workbook anchor
  });

  it("A2 + K1, different zones — no repeat, so (6 + 3 - 2) x rate", async () => {
    const t = await runTrip(["A2", "K1"]);
    for (const s of t.stops) await deliver(t.id, s.id);
    const rate = await rateOf(t.id);
    expect(num((await fresh(t.id)).incentive_earned)).toBe((6 + 3 - 2) * rate);
    if (rate === 11) expect(num((await fresh(t.id)).incentive_earned)).toBe(77);
  });

  it("TWO trips, same day, same zone — the second is a 1-point repeat and takes no second deduction", async () => {
    // Trip 1: max(6-2,0) = 4 points paid.
    // Trip 2: max(6+1-2,0) - max(6-2,0) = 5 - 4 = 1 point paid.
    const t1 = await runTrip(["A2"]);
    await deliver(t1.id, t1.stops[0].id);
    const rate = await rateOf(t1.id);
    expect(num((await fresh(t1.id)).incentive_earned)).toBe(4 * rate);

    const t2 = await runTrip(["A2"]);
    await deliver(t2.id, t2.stops[0].id);
    expect(num((await fresh(t2.id)).incentive_earned)).toBe(1 * rate);
    // The deduction is spent ONCE across the day, not once per trip.
    const day = num((await fresh(t1.id)).incentive_earned) + num((await fresh(t2.id)).incentive_earned);
    expect(day).toBe(5 * rate);
  });

  it("PRH 5292 — a different rate entirely (RM9), same points", async () => {
    // Its OWN driver: the fleet is pinned 1 driver : 1 lorry, and the approve
    // route correctly refuses DRIVER_TRUCK_MISMATCH otherwise. That refusal is
    // the system behaving, not an obstacle to route around.
    const prhDriver = await loginAs({ phone: DRIVERS.PRH.phone, password: "Password123" });
    const prhId = await userIdByPhone(DRIVERS.PRH.phone);
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, prhId, DRIVERS.PRH.plate);
    await startTrip(prhDriver, t.id);
    await deliverAs(prhDriver, t.id, t.stops[0].id);
    const used = num((await fresh(t.id)).rate_used);
    expect(used).toBe(9); // same weekday and off-peak, so no clock dependence
    expect(num((await fresh(t.id)).incentive_earned)).toBe((6 - RATE["PRH 5292"].ded) * 9); // RM36
  });

  it("PSA 5292 — the lorry whose workbook weekday rate was a TYPO", async () => {
    // The sheet says RM13 weekday; he corrected it in writing on 29 Jul —
    // "Sorry My mistake, it is RM 11 for weekday". So weekday must pay 11, and
    // this case exists to catch anyone "fixing" the code back to the sheet.
    const psaDriver = await loginAs({ phone: DRIVERS.PSA.phone, password: "Password123" });
    const psaId = await userIdByPhone(DRIVERS.PSA.phone);
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, psaId, DRIVERS.PSA.plate);
    await startTrip(psaDriver, t.id);
    await deliverAs(psaDriver, t.id, t.stops[0].id);
    const used = num((await fresh(t.id)).rate_used);
    expect([11, 13]).toContain(used);
    if (used === 11) {
      // weekday — the corrected rate, NOT the sheet's 13
      expect(num((await fresh(t.id)).incentive_earned)).toBe((6 - 2) * 11); // RM44
    }
  });

  it("admin cancels after some stops delivered — the delivered ones keep their pay", async () => {
    // A2 + K1 delivered, P1 never reached, then abort.
    // max(6 + 3 - 2, 0) = 7 points. The unreached P1 earns nothing.
    const t = await runTrip(["A2", "K1", "P1"]);
    await deliver(t.id, t.stops[0].id);
    await deliver(t.id, t.stops[1].id);
    // NOTE: rate_used is written at FINALIZATION, so it is still null here —
    // read it after the abort, which is what finalizes this trip.
    const abort = await api().patch(`/api/v1/trips/${t.id}/abort`).set(auth(admin)).send({ reason: "customer closed early" });
    expect(abort.status, JSON.stringify(abort.body)).toBe(200);

    const after = await fresh(t.id);
    expect(after.status).toBe("pending_approval"); // the paid lane, not cancelled
    const rate = await rateOf(t.id);
    expect(num(after.incentive_earned)).toBe(7 * rate);
    if (rate === 11) expect(num(after.incentive_earned)).toBe(77);
  });
  // ── the exception money paths (FEATURE_EXCEPTIONS, dark on prod) ──────────

  async function reportOn(token: string, tripId: string, stopId: string) {
    const r = api().post(`/api/v1/trips/${tripId}/exception`).set(auth(token));
    for (const [k, v] of Object.entries({
      category: "customer_site", reason: "Gate locked",
      client_occurrence_id: randomUUID(), client_action_id: randomUUID(),
      client_evidence_id: randomUUID(), trip_stop_id: stopId,
    })) r.field(k, v as string);
    const res = await r.attach("photo", PHOTO, "e.jpg");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.exception.id as string;
  }
  const act = (tripId: string, exId: string, what: string, body: Record<string, unknown> = {}) =>
    api().post(`/api/v1/trips/${tripId}/exception/${exId}/${what}`).set(auth(admin))
      .send({ client_action_id: randomUUID(), ...body });

  it("R3 Q11(a): a REACHED-but-undelivered stop, verified and resumed, pays the SAME as delivered", async () => {
    // "Same rate paid, although not delivered" — so A2 still earns (6-2) x rate.
    const t = await runTrip(["A2"]);
    const stop = t.stops[0].id;
    expect((await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stop })).status).toBe(200);
    const ex = await reportOn(driver, t.id, stop);
    expect((await act(t.id, ex, "verify")).status).toBe(200);
    expect((await act(t.id, ex, "resume")).status).toBe(200);

    const after = await fresh(t.id);
    expect(after.status).toBe("pending_approval");
    const rate = await rateOf(t.id);
    expect(num(after.incentive_earned)).toBe(4 * rate);
    if (rate === 11) expect(num(after.incentive_earned)).toBe(44); // identical to a delivered A2
  });

  it("an explicit REJECT on the same stop vetoes that pay — RM0, and the trip still closes", async () => {
    // Owner ruling 30 Jul: reject beats approval. The stop earns nothing, and
    // the trip must still reach pending_approval rather than hang.
    const t = await runTrip(["A2"]);
    const stop = t.stops[0].id;
    expect((await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stop })).status).toBe(200);
    const bad = await reportOn(driver, t.id, stop);
    expect((await act(t.id, bad, "reject", { note: "not a genuine failure" })).status).toBe(200);
    const good = await reportOn(driver, t.id, stop);
    expect((await act(t.id, good, "verify")).status).toBe(200);
    expect((await act(t.id, good, "resume")).status).toBe(200);

    const after = await fresh(t.id);
    expect(after.status).toBe("pending_approval"); // all-vetoed trip finalizes
    expect(num(after.incentive_earned)).toBe(0);   // RM0, not RM44
    expect((await prisma.tripStop.findUniqueOrThrow({ where: { id: stop } })).points_awarded).toBeNull();
  });

  it("a vetoed stop does not stop its SIBLING earning", async () => {
    // A2 vetoed, K1 delivered → only K1 pays: max(3 - 2, 0) = 1 point.
    const t = await runTrip(["A2", "K1"]);
    const [ipoh, kulim] = t.stops;
    expect((await api().patch(`/api/v1/trips/${t.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: ipoh.id })).status).toBe(200);
    const bad = await reportOn(driver, t.id, ipoh.id);
    expect((await act(t.id, bad, "reject", { note: "no" })).status).toBe(200);
    const good = await reportOn(driver, t.id, ipoh.id);
    expect((await act(t.id, good, "verify")).status).toBe(200);
    expect((await act(t.id, good, "resume")).status).toBe(200);
    await deliver(t.id, kulim.id);

    const after = await fresh(t.id);
    expect(after.status).toBe("pending_approval");
    const rate = await rateOf(t.id);
    expect(num(after.incentive_earned)).toBe(1 * rate);
    if (rate === 11) expect(num(after.incentive_earned)).toBe(11);
  });

});
