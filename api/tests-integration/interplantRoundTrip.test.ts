import { describe, it, expect, beforeAll } from "vitest";

import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { userIdByPhone, bookTrip, approveTrip, startTrip, arriveAndDeliver, num } from "./helpers/flow";

/**
 * R5 A2 — INTERPLANT IS PAID IN WHOLE ROUND TRIPS, END TO END.
 *
 * `tests/interplantRoundTrip.test.ts` proves the ARITHMETIC. It cannot prove the
 * rule is in the program: the halving is an engine option, and an engine option
 * nobody passes is worth exactly nothing. This file books real interplant trips
 * through the HTTP API and reads what the driver would actually be paid.
 *
 * That distinction is not theoretical here. The engine option defaults to FALSE,
 * so the unit suite stays green in full while `tripFinalize` pays every leg —
 * which is the pre-A2 behaviour, twice the money, and unrecoverable after
 * approval (BL9).
 *
 * ⚠ IM11 FIX (9 Sep 2026) changed the arithmetic itself — see incentiveEngine's
 * `payable` comment. The halving no longer floors: every leg now pays exactly
 * HALF its own points, immediately, regardless of pairing. Re-measured the same
 * way the original numbers were: forcing `roundTripHalving: false` into the
 * call in tripFinalize and running both suites —
 *
 *   tests/interplantRoundTrip.test.ts ....... 13 passed. Notices NOTHING.
 *   this file ............................... 3 of 3 RED, every one
 *                                              "expected 8 to be 4" — the
 *                                              unhalved off-peak rate (8) where
 *                                              half of it (4) was expected. The
 *                                              exact numbers move with the rate
 *                                              in effect when the suite runs;
 *                                              what does not move is that all
 *                                              three fail the instant the flag
 *                                              is unwired.
 *
 * ⚠ And `resetDb` in beforeAll is load-bearing for all three. Without it these
 * read a ledger carrying whatever a previous run left behind, and the first
 * measurement taken while writing this file was wrong for exactly that reason.
 */
/**
 * PND 1888 — the seeded test driver's own lorry, a CUSTOMER lorry with no
 * interplant row of its own. Deliberate: the two designated interplant lorries
 * belong to other drivers and the assign route refuses a driver/truck mismatch,
 * and this way one run exercises BOTH client answers — A3 (a cross-assigned
 * lorry takes interplant pay, the RM6/8 fallback, never PND's own RM11/13) and
 * A2 (that pay is then halved into whole round trips).
 */
const TRUCK = "PND 1888";

let requestor = "", admin = "", driver = "", driverId = "", interplantRt = "";

/** The seeded Inter-Plant Delivery route type — NOT `firstRouteTypeId`, which is
 *  whichever route type happens to come back first and is customer work. */
async function interplantRouteTypeId(token: string): Promise<string> {
  const res = await api().get("/api/v1/route-types").set(auth(token));
  const rt = (res.body as { id: string; name: string }[]).find((r) => r.name === "Inter-Plant Delivery");
  if (!rt) throw new Error(`no Inter-Plant Delivery route type seeded: ${res.text}`);
  return rt.id;
}

/** Book → assign to the interplant lorry → start → deliver its single P2 stop. */
async function runOneLeg(): Promise<{
  incentive: number;
  rate: number;
  points: number;
  shortfall: number | null;
}> {
  const trip = await bookTrip(requestor, ["P2"], interplantRt);
  await approveTrip(admin, trip.id, driverId, TRUCK, true);
  await startTrip(driver, trip.id);
  await arriveAndDeliver(driver, trip.id, trip.stops[0].id);
  const row = await prisma.trip.findUniqueOrThrow({
    where: { id: trip.id },
    select: {
      incentive_earned: true,
      rate_used: true,
      round_trip_shortfall: true,
      stops: { select: { points_awarded: true } },
    },
  });
  return {
    incentive: num(row.incentive_earned),
    rate: num(row.rate_used),
    points: row.stops.reduce((sum, s) => sum + (s.points_awarded ?? 0), 0),
    // DECIMAL column (IM11) — null still means "not recorded", so this can't
    // use `num()` (Number(null) === 0, which would erase that distinction).
    shortfall: row.round_trip_shortfall === null ? null : num(row.round_trip_shortfall),
  };
}

/** Every ringgit this driver has earned on interplant work in this run. */
async function paidToday(): Promise<number> {
  const trips = await prisma.trip.findMany({
    where: { driver_id: driverId, route_type_id: interplantRt, incentive_earned: { not: null } },
    select: { incentive_earned: true },
  });
  return trips.reduce((sum, t) => sum + num(t.incentive_earned), 0);
}

describe("interplant round trips — what the driver is actually paid", () => {
  beforeAll(async () => {
    // The three specs below are ONE day, read cumulatively — leg 1, then legs
    // 1+2, then 1+2+3 — so they must start from an empty ledger. Without this
    // the file passes or fails according to how many interplant trips a previous
    // run happened to leave behind, which is how it behaved while being written.
    await resetDb();
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    interplantRt = await interplantRouteTypeId(requestor);
  });

  it("a lone leg SCORES a point and is PAID half — not nothing (IM11)", async () => {
    const leg = await runOneLeg();
    // The point is real and recorded — this is not "the leg didn't count".
    expect(leg.points).toBe(1);
    // Half a round trip now pays half, not zero. Reading the rate from the
    // trip's own snapshot rather than hard-coding RM6 keeps this correct when
    // the run lands after 18:00 MYT (CI runners are UTC — a fifth of the day).
    expect(leg.incentive).toBe(leg.rate * 0.5);
    expect([6, 8]).toContain(leg.rate); // interplant pay (A3), never PND's own RM11/13
    // ⚠ IM10/IM11: and the WHY is now on the row, as a HALF-point, not a whole
    // one — the gap between points scored and points paid is only half now.
    expect(leg.shortfall).toBe(0.5);
  });

  it("the return leg: BOTH legs pay half, evenly — not zero-then-full", async () => {
    const back = await runOneLeg();
    expect(back.points).toBe(1);
    // Unlike before IM11, the SECOND leg does not pick up the whole pair —
    // it pays exactly the same half-rate the first leg did.
    expect(back.incentive).toBe(back.rate * 0.5);
    expect(back.shortfall).toBe(0.5); // every leg carries a standing half, always

    // ⚠ THIS is the assertion that discriminates. It passes with the rule
    // unwired too if read alone (one unhalved leg also pays exactly one rate),
    // but the DAY TOTAL is what only the halving produces: two halves summing
    // to exactly one round trip, split evenly across the two bookings.
    expect(await paidToday()).toBe(back.rate);
  });

  it("a third leg pays half too, same as the other two — nothing 'waits' any more", async () => {
    const third = await runOneLeg();
    expect(third.incentive).toBe(third.rate * 0.5);

    // The day, read back as a whole: 3 legs, 3 points scored, 1.5 round trips
    // paid (was 1, floored, before IM11 — the third leg no longer sits idle).
    expect(await paidToday()).toBe(third.rate * 1.5);
  });
});
