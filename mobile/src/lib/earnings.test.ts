import { describe, it, expect } from "vitest";
import { isPaid, pendingCount, pendingTotal, weekBuckets, weekStart } from "./earnings";
import type { IncentiveTrip } from "../types";

// Wednesday 2026-07-15, local time — mid-week so the fixtures land either side.
const WEDNESDAY = new Date(2026, 6, 15, 12, 0, 0);

function trip(over: Partial<IncentiveTrip> & { delivered_at: string | null }): IncentiveTrip {
  return {
    id: "t",
    ticket_number: "TKT-1",
    pickup_datetime: over.delivered_at ?? new Date(2026, 6, 15).toISOString(),
    incentive_earned: 0,
    pending: false,
    truck_plate: "PLX 2406",
    route_type: null,
    destination: "PRAI",
    distance_km: 10,
    pallets: 1,
    ...over,
  };
}

/** The server's rule, restated: `summary.total` counts non-pending trips only. */
function serverMonthTotal(trips: IncentiveTrip[]): number {
  return trips.filter((t) => !t.pending).reduce((s, t) => s + Number(t.incentive_earned ?? 0), 0);
}

describe("the chart and the summary card must agree", () => {
  it("REGRESSION: chart total equals the server's paid total when a pending trip is present", () => {
    // The defect: the chart summed ALL trips while the card above it showed the
    // server's total, which excludes pending. One screen, two totals — and the
    // bigger one counted money the driver had not been paid.
    const trips = [
      trip({ delivered_at: new Date(2026, 6, 13, 9).toISOString(), incentive_earned: 44, pending: false }),
      trip({ delivered_at: new Date(2026, 6, 15, 9).toISOString(), incentive_earned: 33, pending: true }),
      trip({ delivered_at: new Date(2026, 6, 16, 9).toISOString(), incentive_earned: 11, pending: false }),
    ];

    const chartTotal = weekBuckets(trips, WEDNESDAY).reduce((a, b) => a + b, 0);

    expect(chartTotal).toBe(55); // 44 + 11 — the 33 is proposed, not earned
    expect(chartTotal).toBe(serverMonthTotal(trips));
  });

  it("no money vanishes — paid + pending accounts for every trip", () => {
    const trips = [
      trip({ delivered_at: new Date(2026, 6, 13, 9).toISOString(), incentive_earned: 44, pending: false }),
      trip({ delivered_at: new Date(2026, 6, 15, 9).toISOString(), incentive_earned: 33, pending: true }),
    ];
    const chartTotal = weekBuckets(trips, WEDNESDAY).reduce((a, b) => a + b, 0);

    // Pending money is EXCLUDED from paid but still surfaced separately — the
    // driver must be able to see it, just never as money he has been paid.
    expect(chartTotal + pendingTotal(trips)).toBe(77);
    expect(pendingTotal(trips)).toBe(33);
    expect(pendingCount(trips)).toBe(1);
  });
});

describe("weekBuckets", () => {
  it("buckets Mon-first on the delivery-confirm day, not pickup", () => {
    const trips = [
      // Picked up Sunday night, delivered Monday 00:30 — pay belongs to MONDAY.
      trip({
        pickup_datetime: new Date(2026, 6, 12, 23, 30).toISOString(),
        delivered_at: new Date(2026, 6, 13, 0, 30).toISOString(),
        incentive_earned: 44,
      }),
    ];
    const buckets = weekBuckets(trips, WEDNESDAY);
    expect(buckets[0]).toBe(44); // Monday
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(44);
  });

  it("ignores trips outside the current week", () => {
    const trips = [
      trip({ delivered_at: new Date(2026, 6, 6, 9).toISOString(), incentive_earned: 99 }), // last week
      trip({ delivered_at: new Date(2026, 6, 15, 9).toISOString(), incentive_earned: 11 }), // this week
    ];
    expect(weekBuckets(trips, WEDNESDAY).reduce((a, b) => a + b, 0)).toBe(11);
  });

  it("falls back to pickup for a trip with no delivery confirm", () => {
    const trips = [
      trip({ pickup_datetime: new Date(2026, 6, 14, 9).toISOString(), delivered_at: null, incentive_earned: 22 }),
    ];
    expect(weekBuckets(trips, WEDNESDAY)[1]).toBe(22); // Tuesday
  });
});

describe("isPaid", () => {
  it("treats a pending trip as NOT paid", () => {
    expect(isPaid(trip({ delivered_at: null, pending: true }))).toBe(false);
    expect(isPaid(trip({ delivered_at: null, pending: false }))).toBe(true);
  });

  it("GRANDFATHERED: a trip from an API build with no `pending` field counts as paid", () => {
    // Trips that predate the approval gate were auto-paid. `pending !== true`
    // (not `=== false`) so a missing field reads as paid, never as held money.
    const legacy = trip({ delivered_at: null, incentive_earned: 33 });
    delete (legacy as Partial<IncentiveTrip>).pending;
    expect(isPaid(legacy)).toBe(true);
    expect(pendingTotal([legacy])).toBe(0);
  });
});

describe("weekStart", () => {
  it("returns local Monday midnight for any day of the week", () => {
    const monday = weekStart(WEDNESDAY);
    expect(monday.getDay()).toBe(1);
    expect(monday.getHours()).toBe(0);
    expect(monday.getDate()).toBe(13);
    // Idempotent — Monday's own week starts on itself.
    expect(weekStart(monday).getTime()).toBe(monday.getTime());
  });
});
