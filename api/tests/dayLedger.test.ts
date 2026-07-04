import { describe, it, expect } from "vitest";
import {
  priorDeliveredDropsWhere,
  LEDGER_TRIP_STATUSES,
  type PriorDeliveredDropsWhere,
} from "../src/services/dayLedger";
import {
  calculateDeliveryIncentive,
  groupStopsByDeliveryDay,
  getTripDayStart,
} from "../src/services/incentiveEngine";

/**
 * MONEY PATH — the finalize day-ledger (money-path review, 4 Jul 2026).
 *
 * The old ledger counted only COMPLETED trips over the whole MYT day, so two
 * overlapping trips to the same zone each saw an empty ledger — both paid the
 * zone's full points AND both took the daily deduction (RM88 where the
 * client-confirmed rule says RM55). These tests pin the hardened semantics:
 * in_progress drops count, and only drops delivered BEFORE this group's first
 * confirm feed the ledger. The incentive RULE itself is untouched — the
 * engine tests (incentive.test.ts, incl. the RM44 anchor) all still apply.
 */

// PLX 2406: weekday RM11, off-peak RM13, deduction 2 pts. Ipoh A2 = 6, Kulim K1 = 3.
const PLX2406 = { daily_deduction_points: 2, entitled_claim_weekday: 11, entitled_claim_offpeak: 13 };
const NO_HOLIDAYS: ReadonlySet<string> = new Set();

// A delivered stop row as the ledger sees it (DB shape flattened for the fake).
interface StopRow {
  trip_id: string;
  trip_status: string;
  driver_id: string;
  zone_code: string;
  stop_status: string;
  delivered_at: Date;
}

// In-memory evaluator for exactly the where-shape priorDeliveredDropsWhere
// builds — the test-side stand-in for Postgres applying it to trip_stops.
function ledgerZones(stops: StopRow[], where: PriorDeliveredDropsWhere): string[] {
  return stops
    .filter((s) => s.stop_status === where.status)
    .filter((s) => s.delivered_at >= where.delivered_at.gte && s.delivered_at < where.delivered_at.lt)
    .filter((s) => s.driver_id === where.trip.driver_id)
    .filter((s) => where.trip.status.in.includes(s.trip_status as "in_progress" | "completed"))
    .filter((s) => s.trip_id !== where.trip.id.not)
    .map((s) => s.zone_code);
}

// Finalize one single-stop trip the way trips.ts does: group its stops, build
// the ledger from the production where-builder, run the production engine.
function finalizeTrip(allStops: StopRow[], tripId: string, driverId: string, zonePoints: number) {
  const own = allStops.filter((s) => s.trip_id === tripId);
  const groups = groupStopsByDeliveryDay(own, new Date("2026-06-22T12:00:00Z"));
  expect(groups).toHaveLength(1);
  const group = groups[0];
  const zones = ledgerZones(
    allStops,
    priorDeliveredDropsWhere({
      driverId,
      excludeTripId: tripId,
      dayStart: group.dayStart,
      anchor: group.anchor,
    })
  );
  return calculateDeliveryIncentive({
    publicHolidays: NO_HOLIDAYS,
    rateDateTime: group.anchor,
    drops: group.stops.map((s) => ({ zoneCode: s.zone_code, zonePoints })),
    zonesDeliveredEarlierToday: zones,
    isFirstDeliveredDropOfDay: zones.length === 0,
    truck: PLX2406,
  });
}

describe("priorDeliveredDropsWhere — the ledger's semantics, pinned", () => {
  const dayStart = new Date("2026-06-21T16:00:00Z"); // Mon 2026-06-22 00:00 MYT
  const anchor = new Date("2026-06-22T02:30:00Z"); // Mon 10:30 MYT
  const where = priorDeliveredDropsWhere({
    driverId: "d1",
    excludeTripId: "tB",
    dayStart,
    anchor,
  });

  it("counts drops from in_progress AND completed trips (not completed-only)", () => {
    expect(LEDGER_TRIP_STATUSES).toEqual(["in_progress", "completed"]);
    expect(where.trip.status).toEqual({ in: ["in_progress", "completed"] });
  });

  it("only counts drops delivered before this group's first confirm ([dayStart, anchor))", () => {
    expect(where.delivered_at).toEqual({ gte: dayStart, lt: anchor });
  });

  it("excludes the trip being finalized and scopes to the driver's delivered stops", () => {
    expect(where.trip.id).toEqual({ not: "tB" });
    expect(where.trip.driver_id).toBe("d1");
    expect(where.status).toBe("delivered");
  });
});

describe("overlapping trips — the RM88→RM55 double-first-drop hole (MONEY)", () => {
  // Driver d1 on PLX 2406, weekday. Trip A delivers Ipoh at 10:00 MYT; trip B
  // (started while A was still out — the double-in_progress state) delivers
  // Ipoh at 10:30 MYT. Trip B finalizes while A is STILL in_progress — the
  // exact race where the old completed-only ledger showed B an empty day.
  const stops: StopRow[] = [
    {
      trip_id: "tA",
      trip_status: "in_progress",
      driver_id: "d1",
      zone_code: "A2",
      stop_status: "delivered",
      delivered_at: new Date("2026-06-22T02:00:00Z"), // Mon 10:00 MYT
    },
    {
      trip_id: "tB",
      trip_status: "in_progress",
      driver_id: "d1",
      zone_code: "A2",
      stop_status: "delivered",
      delivered_at: new Date("2026-06-22T02:30:00Z"), // Mon 10:30 MYT
    },
  ];

  it("CLIENT FIGURE: same-zone overlap pays RM44 + RM11 = RM55, deduction once — not RM88", () => {
    // Trip A finalizes: nothing delivered before ITS 10:00 anchor → day's
    // first drop → full 6 points, minus the once-per-day deduction.
    const a = finalizeTrip(stops, "tA", "d1", 6);
    expect(a.dropPoints).toEqual([6]);
    expect(a.deductionApplied).toBe(2);
    expect(a.incentiveThisTrip).toBe(44); // (6−2)×11 — the anchor figure

    // Trip B finalizes while A is still in_progress: A's 10:00 drop is on the
    // ledger anyway → same-zone repeat (1 pt), and the deduction is NOT
    // re-applied. Under the old completed-only ledger B also paid RM44.
    const b = finalizeTrip(stops, "tB", "d1", 6);
    expect(b.dropPoints).toEqual([1]);
    expect(b.deductionApplied).toBe(0);
    expect(b.incentiveThisTrip).toBe(11); // 1×11

    expect(a.incentiveThisTrip + b.incentiveThisTrip).toBe(55);
    expect(a.deductionApplied + b.deductionApplied).toBe(2); // once, total
  });

  it("finalization ORDER doesn't matter: B finalizing first pays the same split", () => {
    // The ledger keys on delivered_at, not on which finalization ran first —
    // B's ledger sees A's earlier drop either way, and A's ledger can never
    // see B's LATER drop (anchor bound), so A still pays full + deduction.
    const b = finalizeTrip(stops, "tB", "d1", 6);
    const a = finalizeTrip(stops, "tA", "d1", 6);
    expect(b.incentiveThisTrip).toBe(11);
    expect(a.incentiveThisTrip).toBe(44);
  });

  it("the anchor bound protects the FIRST trip: a later sibling drop never demotes it", () => {
    // Without `delivered_at < anchor`, counting in_progress trips would have
    // shown A the 10:30 drop too — A would score a 1-pt repeat with no
    // deduction and NOBODY would pay the full points (RM22 for the pair).
    const a = finalizeTrip(stops, "tA", "d1", 6);
    expect(a.dropPoints).toEqual([6]); // still the day's first drop
    expect(a.deductionApplied).toBe(2);
  });

  it("different-zone overlap: second trip pays full points, still no second deduction", () => {
    const kulim: StopRow[] = [
      stops[0], // Ipoh 10:00 MYT, in_progress
      { ...stops[1], zone_code: "K1" }, // Kulim 10:30 MYT, in_progress
    ];
    const a = finalizeTrip(kulim, "tA", "d1", 6);
    const b = finalizeTrip(kulim, "tB", "d1", 3);
    expect(a.incentiveThisTrip).toBe(44); // (6−2)×11
    expect(b.dropPoints).toEqual([3]); // fresh zone → full points
    expect(b.deductionApplied).toBe(0); // deduction already spent on the day's first drop
    expect(b.incentiveThisTrip).toBe(33); // 3×11
    expect(a.incentiveThisTrip + b.incentiveThisTrip).toBe(77); // (6+3−2)×11
  });

  it("serial trips (the normal flow) are unchanged: completed prior trip feeds the ledger as before", () => {
    const serial: StopRow[] = [
      { ...stops[0], trip_status: "completed" }, // A finished and finalized first
      stops[1],
    ];
    const b = finalizeTrip(serial, "tB", "d1", 6);
    expect(b.dropPoints).toEqual([1]);
    expect(b.incentiveThisTrip).toBe(11);
  });

  it("another driver's same-zone drop this day never touches this driver's ledger", () => {
    const otherDriver: StopRow[] = [
      { ...stops[0], driver_id: "d2" }, // someone else delivered Ipoh at 10:00
      stops[1],
    ];
    const b = finalizeTrip(otherDriver, "tB", "d1", 6);
    expect(b.dropPoints).toEqual([6]); // fresh for THIS driver
    expect(b.deductionApplied).toBe(2); // and it's his day's first drop
    expect(b.incentiveThisTrip).toBe(44);
  });

  it("yesterday's drop in the same zone is not on today's ledger (day window intact)", () => {
    const staleYesterday: StopRow[] = [
      { ...stops[0], delivered_at: new Date("2026-06-21T02:00:00Z") }, // Sun 10:00 MYT
      stops[1],
    ];
    // Sanity: the two drops really are on different MYT days.
    expect(getTripDayStart(staleYesterday[0].delivered_at).getTime()).not.toBe(
      getTripDayStart(stops[1].delivered_at).getTime()
    );
    const b = finalizeTrip(staleYesterday, "tB", "d1", 6);
    expect(b.dropPoints).toEqual([6]); // points refreshed at midnight
    expect(b.deductionApplied).toBe(2);
  });
});
