import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import { bookTrip, autoDispatch, firstRouteTypeId, pallets } from "./helpers/flow";

/**
 * IP1 — AUTO-DISPATCH PICKS ITS POOL FROM THE WORK, NOT FROM THE PLATE.
 *
 * Mr. Teh, 28 Jul 2026 email, pts 1–2: PLX 2406 and PPE 2406 are removed from
 * "auto dispatch to customer / supplier delivery". The engine removed them from
 * auto dispatch ENTIRELY, so the two lorries designated FOR plant runs could
 * never be auto-assigned TO one — and an auto-dispatched interplant booking went
 * to a customer lorry, which then drew the interplant FALLBACK rate (PLX's 6/8)
 * rather than PPE 2406's own 5/7. RM1 a point more, on work the client had just
 * moved OFF the customer fleet. Found by the owner, 11 Aug 2026.
 *
 * ⚠ WHY THIS FILE EXISTS SEPARATELY FROM tests/dispatch.test.ts.
 * The unit cases there prove `inAutoDispatchPool` computes the right answer.
 * They cannot prove the ENGINE ASKS IT — the predicate takes a route type, and
 * a route type nobody passes is worth nothing. Measured, by putting the old
 * line back at the call site (`.filter((t) => !isInterplantPlate(t.plate))`)
 * and running both suites:
 *
 *   tests/dispatch.test.ts .............. 38 passed. Notices NOTHING.
 *   this file .......................... 3 of 4 RED.
 *
 *     "takes an interplant lorry" ... expected [ 'PLX 2406', 'PPE 2406' ] to
 *                                     include 'PRH 5292'
 *     "9-pallet plant run" .......... expected 'PND 1888' to be 'PLX 2406'
 *     "waits for an admin" .......... expected 200 to be 409
 *
 * The fourth (a customer booking never gets an interplant lorry) stays GREEN
 * either way by design — it is the negative control for the OTHER direction,
 * the one that was already right and must not be traded away for this fix.
 *
 * ⚠ The "waits for an admin" case is the one that encodes a JUDGEMENT, so it is
 * stated here rather than buried: when neither interplant lorry is free, auto
 * does NOT fall back to the customer fleet. Cross-class work is the admin's to
 * authorise — "As a backup, All lorry still can swap between interplant and
 * customer / supplier delivery … authorize by admin" (same email, pt 6). Auto
 * silently doing it would be the very substitution that produced this bug.
 */

const INTERPLANT_PLATES = ["PLX 2406", "PPE 2406"];

/** The seeded Inter-Plant Delivery route type — NOT firstRouteTypeId, which is
 *  whichever comes back first and is customer work. */
async function interplantRouteTypeId(token: string): Promise<string> {
  const res = await api().get("/api/v1/route-types").set(auth(token));
  const rt = (res.body as { id: string; name: string }[]).find((r) => r.name === "Inter-Plant Delivery");
  if (!rt) throw new Error(`no Inter-Plant Delivery route type seeded: ${res.text}`);
  return rt.id;
}

async function assignedPlate(tripId: string): Promise<string | null> {
  const t = await prisma.trip.findUnique({ where: { id: tripId }, select: { truck_plate: true } });
  return t?.truck_plate ?? null;
}

describe("IP1 — the service-class gate is scoped to the booking's route type", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("an INTERPLANT booking takes an interplant lorry — never one of the seven", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const trip = await bookTrip(requestor, ["P2"], await interplantRouteTypeId(requestor));

    expect((await autoDispatch(admin, trip.id)).status).toBe(200);
    // Every customer lorry is idle and fits this 1-pallet run, so nothing but
    // the route type can be steering the choice.
    expect(INTERPLANT_PLATES).toContain(await assignedPlate(trip.id));
  });

  it("a 9-pallet plant run takes PLX 2406 — the only interplant lorry that fits", async () => {
    // Sharpens the case above: 9 pallets exceeds PPE 2406 (8), so within the
    // interplant pool only PLX (16) can serve it. Both 14-pallet CUSTOMER
    // lorries also fit 9 — which is exactly what the engine used to pick.
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const trip = await bookTrip(requestor, ["P2"], await interplantRouteTypeId(requestor), pallets(9));

    expect((await autoDispatch(admin, trip.id)).status).toBe(200);
    expect(await assignedPlate(trip.id)).toBe("PLX 2406");
  });

  it("with both interplant lorries out, the booking WAITS for an admin instead of taking a customer lorry", async () => {
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    await prisma.truck.updateMany({
      where: { plate: { in: INTERPLANT_PLATES } },
      data: { is_available: false },
    });
    const trip = await bookTrip(requestor, ["P2"], await interplantRouteTypeId(requestor));

    const res = await autoDispatch(admin, trip.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");

    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.status).toBe("pending");
    expect(after.truck_plate).toBeNull(); // crucially NOT a customer lorry
    expect(after.auto_dispatch_failed).toBe(true);
    // And the note tells the dispatcher WHICH pool was empty, so nobody hunts
    // for capacity that was never the problem.
    expect(after.auto_dispatch_note).toBe(
      "No interplant lorry (PLX 2406 / PPE 2406) is free for this booking — assign a backup lorry by hand."
    );
  });

  it("a CUSTOMER booking still never gets an interplant lorry (the rule that was already right)", async () => {
    // The negative control. This fix widens the interplant plates' eligibility;
    // it must not widen it in the direction the client actually asked to close.
    const [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    const trip = await bookTrip(requestor, ["P2"], await firstRouteTypeId(requestor), pallets(11));

    expect((await autoDispatch(admin, trip.id)).status).toBe(200);
    expect(INTERPLANT_PLATES).not.toContain(await assignedPlate(trip.id));
  });
});
