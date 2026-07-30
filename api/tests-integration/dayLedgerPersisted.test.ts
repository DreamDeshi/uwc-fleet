import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../src/lib/cloudinary", () => ({
  uploadBuffer: vi.fn(async (_buf: Buffer, folder: string) => ({
    url: `https://res.cloudinary.test/${folder}/authenticated`,
    publicId: `${folder}/pub_${randomUUID()}`,
    resourceType: "image",
    format: "jpg",
  })),
  isCloudinaryConfigured: () => true,
  cloudinary: { url: (publicId: string) => `https://res.cloudinary.test/signed/${publicId}` },
}));

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, firstRouteTypeId, bookTrip, approveTrip, startTrip, num } from "./helpers/flow";

/**
 * THE DAY LEDGER READS WHAT WAS **PAID**, NOT WHAT THE LIVE RULE WOULD PAY NOW.
 * MONEY PATH, and the one the owner asked be covered at DB level rather than
 * with unit tests.
 *
 * `tests/dayLedger.test.ts` evaluates the where-clause with a HAND-WRITTEN
 * interpreter. That is fine for scoring arithmetic and worthless for this: the
 * whole question is what Prisma emits for a nested OR over a nullable column,
 * and an interpreter that agrees with my assumptions proves only that I am
 * self-consistent. These run against Postgres.
 *
 * TWO fallback populations share one rule, which is why it needs real coverage:
 *
 *   1. IN-FLIGHT stops. Scoring happens at finalization, but the ledger spans
 *      `in_progress` trips on purpose (overlapping trips — the RM88→RM55 hole).
 *      Those stops have no `points_awarded` and MUST still occupy their zone.
 *   2. LEGACY stops finalized before the breakdown feature wrote the column.
 *
 * Getting the fallback wrong silently drops trips out of the ledger and lets the
 * same zone pay a full first drop twice in one MYT day.
 *
 * Seeded PND 1888: Ipoh (A2) 6 pts, Kulim (K1) 3 pts, deduction 2.
 */

const PND_PLATE = "PND 1888";
const PHOTO = Buffer.from("fake-jpeg-bytes");

let requestor = "", admin = "", driver = "", driverId = "", rt = "";

describe("day ledger — persisted evidence vs the live rule", () => {
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
  beforeEach(async () => {
    await resetDb();
  });

  async function startedTrip(zones: string[]) {
    const t = await bookTrip(requestor, zones, rt);
    await approveTrip(admin, t.id, driverId, PND_PLATE);
    await startTrip(driver, t.id);
    return t;
  }

  async function deliverStop(tripId: string, stopId: string) {
    const arrived = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect([200, 400]).toContain(arrived.status);
    await prisma.tripStop.update({ where: { id: stopId }, data: { pod_photo: "test://pod.jpg", do_uploaded: true } });
    const res = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "delivered", stop_id: stopId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** Arrive, report a failure, verify + resume it — the paid-undelivered path. */
  async function failAndSettle(tripId: string, stopId: string) {
    const arrived = await api().patch(`/api/v1/trips/${tripId}/status`).set(auth(driver)).send({ action: "arrived", stop_id: stopId });
    expect([200, 400]).toContain(arrived.status);
    const r = api().post(`/api/v1/trips/${tripId}/exception`).set(auth(driver));
    for (const [k, v] of Object.entries({
      category: "customer_site",
      reason: "Gate locked",
      client_occurrence_id: randomUUID(),
      client_action_id: randomUUID(),
      client_evidence_id: randomUUID(),
      trip_stop_id: stopId,
    })) r.field(k, v as string);
    const reported = await r.attach("photo", PHOTO, "e.jpg");
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const exId = reported.body.exception.id as string;
    expect((await api().post(`/api/v1/trips/${tripId}/exception/${exId}/verify`).set(auth(admin)).send({ client_action_id: randomUUID() })).status).toBe(200);
    expect((await api().post(`/api/v1/trips/${tripId}/exception/${exId}/resume`).set(auth(admin)).send({ client_action_id: randomUUID() })).status).toBe(200);
    return exId;
  }

  /** Points the engine gave a stop, from what finalization persisted. */
  const pointsOf = async (stopId: string) =>
    (await prisma.tripStop.findUniqueOrThrow({ where: { id: stopId } })).points_awarded;

  it("PERSISTED WINS: rejecting an exception AFTER the stop was paid does not remove it from the ledger", async () => {
    // THE REGRESSION TEST for the non-monotonicity hole. Trip A's Ipoh stop is
    // settled and PAID (6 pts). A sibling report is then rejected. Trip B's Ipoh
    // drop must still score as a same-zone REPEAT (1 pt) — the earlier stop was
    // paid, so it occupied the zone. Reading the live rule instead would pay
    // full points twice for Ipoh on one MYT day (~RM33).
    const a = await startedTrip(["A2"]);
    await failAndSettle(a.id, a.stops[0].id);
    expect(await pointsOf(a.stops[0].id)).toBe(6); // paid, and persisted

    // A second report on the SAME stop, rejected after the fact.
    const r = api().post(`/api/v1/trips/${a.id}/exception`).set(auth(driver));
    for (const [k, v] of Object.entries({
      category: "customer_site", reason: "second look",
      client_occurrence_id: randomUUID(), client_action_id: randomUUID(),
      client_evidence_id: randomUUID(), trip_stop_id: a.stops[0].id,
    })) r.field(k, v as string);
    const second = await r.attach("photo", PHOTO, "e.jpg");
    // The trip already finalized, so the report is refused — construct the state
    // directly, which is exactly the post-payment adjudication being guarded.
    if (second.status !== 201) {
      await prisma.tripException.create({
        data: {
          trip_id: a.id, trip_stop_id: a.stops[0].id, client_occurrence_id: randomUUID(),
          category: "customer_site", reason: "late reject", reported_by: driverId,
          current_state: "rejected", closed_at: new Date(),
        },
      });
    }

    const b = await startedTrip(["A2"]);
    await deliverStop(b.id, b.stops[0].id);

    expect(await pointsOf(b.stops[0].id)).toBe(1); // repeat — the ledger held
    expect(num((await prisma.trip.findUniqueOrThrow({ where: { id: b.id } })).incentive_earned)).toBeGreaterThan(0);
  });

  it("IN-FLIGHT FALLBACK: a delivered stop on a still-running trip occupies its zone", async () => {
    // Population 1. `points_awarded` is null because trip A has not finalized,
    // so ONLY the live fallback can see it. Keying purely on persisted evidence
    // would reopen the RM88→RM55 double-first-drop hole for every overlap.
    const a = await startedTrip(["A2", "K1"]);
    await deliverStop(a.id, a.stops[0].id); // Ipoh delivered; Kulim still open
    expect(await pointsOf(a.stops[0].id)).toBeNull(); // NOT scored yet
    expect((await prisma.trip.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("in_progress");

    // Second trip, same driver, same day, same zone. The guard normally refuses
    // a second active trip, so the ledger's own overlap case is built directly.
    const b = await bookTrip(requestor, ["A2"], rt);
    await prisma.trip.update({
      where: { id: b.id },
      data: { status: "in_progress", driver_id: driverId, truck_plate: PND_PLATE },
    });
    await deliverStop(b.id, b.stops[0].id);

    expect(await pointsOf(b.stops[0].id)).toBe(1); // repeat, via the fallback
  });

  it("LEGACY FALLBACK: a settled stop with NO persisted points still occupies its zone", async () => {
    // Population 2. Simulates a trip finalized before the breakdown feature
    // wrote points_awarded: settled by the live rule, no persisted evidence.
    const a = await startedTrip(["A2"]);
    await failAndSettle(a.id, a.stops[0].id);
    await prisma.tripStop.update({ where: { id: a.stops[0].id }, data: { points_awarded: null } });
    expect(await pointsOf(a.stops[0].id)).toBeNull();

    const b = await startedTrip(["A2"]);
    await deliverStop(b.id, b.stops[0].id);

    expect(await pointsOf(b.stops[0].id)).toBe(1); // repeat — fallback saw it
  });

  it("a legacy stop that was NEVER settled does not occupy its zone", async () => {
    // The other side of the fallback: no persisted evidence AND the live rule
    // says unpaid ⇒ it must NOT demote a later drop. Over-counting here would
    // cost the driver a full first drop.
    const a = await startedTrip(["A2", "K1"]);
    // Arrive at Ipoh and report, but never adjudicate it.
    const r = api().post(`/api/v1/trips/${a.id}/exception`).set(auth(driver));
    await api().patch(`/api/v1/trips/${a.id}/status`).set(auth(driver)).send({ action: "arrived", stop_id: a.stops[0].id });
    for (const [k, v] of Object.entries({
      category: "customer_site", reason: "unadjudicated",
      client_occurrence_id: randomUUID(), client_action_id: randomUUID(),
      client_evidence_id: randomUUID(), trip_stop_id: a.stops[0].id,
    })) r.field(k, v as string);
    expect((await r.attach("photo", PHOTO, "e.jpg")).status).toBe(201);
    expect(await pointsOf(a.stops[0].id)).toBeNull();

    const b = await bookTrip(requestor, ["A2"], rt);
    await prisma.trip.update({
      where: { id: b.id },
      data: { status: "in_progress", driver_id: driverId, truck_plate: PND_PLATE },
    });
    await deliverStop(b.id, b.stops[0].id);

    expect(await pointsOf(b.stops[0].id)).toBe(6); // FULL first drop, not a repeat
  });
});
