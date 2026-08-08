import { describe, it, expect } from "vitest";
import { periodBounds, periodStats, startOfWeek, weekSeries } from "./requestorInsights";
import type { Trip, TripStatus } from "../types";

// A Wednesday, 12 August 2026, 09:00 local.
const NOW = new Date(2026, 7, 12, 9, 0, 0, 0);

let seq = 0;
function trip(
  pickup: Date,
  status: TripStatus = "completed",
  cargo: { pallet_type: string; quantity: number }[] = [{ pallet_type: "4×4", quantity: 4 }]
): Trip {
  seq += 1;
  return {
    id: `t${seq}`,
    ticket_number: `TKT-${seq}`,
    status,
    pickup_datetime: pickup.toISOString(),
    created_at: pickup.toISOString(),
    cargo_details: cargo,
  } as unknown as Trip;
}

const day = (d: number, h = 10) => new Date(2026, 7, d, h, 0, 0, 0);

describe("periodBounds", () => {
  it("this month runs from the 1st to the 1st of next month", () => {
    const b = periodBounds("month", NOW);
    expect(b.start).toEqual(new Date(2026, 7, 1));
    expect(b.end).toEqual(new Date(2026, 8, 1));
    expect(b.prevStart).toEqual(new Date(2026, 6, 1));
    expect(b.prevEnd).toEqual(b.start);
  });

  it("last 90 days is a rolling window with an equally long baseline", () => {
    const b = periodBounds("quarter", NOW);
    expect(Math.round((+b.end - +b.start) / 86_400_000)).toBe(90);
    expect(Math.round((+b.start - +b.prevStart) / 86_400_000)).toBe(90);
  });
});

describe("periodStats", () => {
  it("counts only the bookings whose PICKUP falls inside the period", () => {
    // Bucketed on pickup, not created_at: a July booking for an August pickup
    // is an August trip to the person reading the tile.
    const julyPickup = trip(new Date(2026, 6, 20));
    const augPickup = trip(day(3));
    const stats = periodStats([julyPickup, augPickup], "month", NOW);
    expect(stats.total).toBe(1);
  });

  it("computes the delta against the previous window", () => {
    const trips = [
      // August: 3
      trip(day(2)), trip(day(4)), trip(day(6)),
      // July: 2
      trip(new Date(2026, 6, 2)), trip(new Date(2026, 6, 4)),
    ];
    const stats = periodStats(trips, "month", NOW);
    expect(stats.total).toBe(3);
    expect(stats.deltaPct).toBe(50);
  });

  it("reports no delta rather than an infinite one when there is no baseline", () => {
    // "▲ ∞% vs last month" against a zero prior month is not a fact.
    expect(periodStats([trip(day(2))], "month", NOW).deltaPct).toBeNull();
  });

  it("counts rejected alongside cancelled — both are trucks the requestor didn't get", () => {
    const trips = [
      trip(day(2), "completed"),
      trip(day(3), "cancelled"),
      trip(day(4), "rejected"),
      trip(day(5), "assigned"),
    ];
    const stats = periodStats(trips, "month", NOW);
    expect(stats.cancelled).toBe(2);
    expect(stats.cancelledPct).toBe(50);
  });

  it("counts a delivered-awaiting-approval booking as completed", () => {
    // The goods arrived; the outstanding step is an internal pay approval.
    const stats = periodStats([trip(day(2), "pending_approval")], "month", NOW);
    expect(stats.completed).toBe(1);
  });

  it("averages pallets in 4×4-equivalents, the same unit the truck bar uses", () => {
    const trips = [
      trip(day(2), "completed", [{ pallet_type: "4×4", quantity: 4 }]), // 4.0
      trip(day(3), "completed", [{ pallet_type: "2×2", quantity: 4 }]), // 1.0
    ];
    expect(periodStats(trips, "month", NOW).avgPallets).toBe(2.5);
  });

  it("returns nulls rather than NaN or 0% for an empty period", () => {
    const stats = periodStats([], "month", NOW);
    expect(stats).toMatchObject({ total: 0, cancelledPct: null, avgPallets: null, deltaPct: null });
  });
});

describe("weekSeries", () => {
  it("starts the week on Monday", () => {
    // 12 Aug 2026 is a Wednesday; its Monday is the 10th.
    expect(startOfWeek(NOW)).toEqual(new Date(2026, 7, 10));
    // A Sunday must belong to the week that STARTED, not the one about to.
    expect(startOfWeek(new Date(2026, 7, 16, 23))).toEqual(new Date(2026, 7, 10));
  });

  it("buckets this week's pickups Mon → Sun and marks today", () => {
    const trips = [trip(day(10)), trip(day(12)), trip(day(12)), trip(day(16))];
    const bars = weekSeries(trips, NOW);
    expect(bars.map((b) => b.count)).toEqual([1, 0, 2, 0, 0, 0, 1]);
    expect(bars.filter((b) => b.isToday).map((b) => b.index)).toEqual([2]); // Wednesday
  });

  it("ignores bookings outside the current week", () => {
    expect(weekSeries([trip(day(3)), trip(day(24))], NOW).every((b) => b.count === 0)).toBe(true);
  });

  it("always returns seven bars, even with no bookings at all", () => {
    expect(weekSeries([], NOW)).toHaveLength(7);
  });
});
