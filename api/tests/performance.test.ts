import { describe, it, expect } from "vitest";
import { computeScore, isTripOnTime, type DriverTripStats } from "../src/lib/performanceScore";

// Driver performance score — FR-FM7. The score is three weighted components:
// on-time (40%), completion (30%), normalised incentive points (30%).

describe("computeScore — perfect score", () => {
  it("gives 100 when on-time, never cancelled, and the top earner", () => {
    const stats: DriverTripStats = {
      onTimeCompleted: 20,
      totalCompleted: 20,
      cancelled: 0,
      pointsThisMonth: 500,
    };
    // maxPoints === this driver's points → full 30 on the points component.
    const s = computeScore(stats, 500);

    expect(s.on_time_rate).toBe(100);
    expect(s.completion_rate).toBe(100);
    expect(s.on_time_component).toBe(40);
    expect(s.completion_component).toBe(30);
    expect(s.points_component).toBe(30);
    expect(s.total_score).toBe(100);
  });
});

describe("computeScore — zero trips", () => {
  it("scores 0 across the board with no divide-by-zero", () => {
    const stats: DriverTripStats = {
      onTimeCompleted: 0,
      totalCompleted: 0,
      cancelled: 0,
      pointsThisMonth: 0,
    };
    const s = computeScore(stats, 0); // no driver earned anything this month

    expect(s.on_time_rate).toBe(0);
    expect(s.completion_rate).toBe(0);
    expect(s.points_component).toBe(0);
    expect(s.total_score).toBe(0);
  });
});

describe("computeScore — normalisation across drivers", () => {
  it("ranks a higher-earning driver above a lower one, all else equal", () => {
    const base = { onTimeCompleted: 10, totalCompleted: 10, cancelled: 0 };
    const maxPoints = 1000; // the top earner this month

    const top = computeScore({ ...base, pointsThisMonth: 1000 }, maxPoints);
    const half = computeScore({ ...base, pointsThisMonth: 500 }, maxPoints);

    // On-time and completion are identical; only the points component differs.
    expect(top.points_component).toBe(30); // 1000/1000 * 30
    expect(half.points_component).toBe(15); // 500/1000 * 30
    expect(top.total_score).toBeGreaterThan(half.total_score);
    expect(top.total_score - half.total_score).toBeCloseTo(15, 5);
  });
});

describe("computeScore — partial components", () => {
  it("weights on-time 40%, completion 30%, points 30%", () => {
    // 80% on-time, 4 of 5 assigned completed (80%), half the top earner.
    const s = computeScore(
      { onTimeCompleted: 8, totalCompleted: 10, cancelled: 0, pointsThisMonth: 50 },
      100
    );
    expect(s.on_time_rate).toBe(80);
    expect(s.on_time_component).toBe(32); // 0.8 * 40
    expect(s.points_component).toBe(15); // 0.5 * 30
  });

  it("completion rate counts cancelled trips against the driver", () => {
    const s = computeScore(
      { onTimeCompleted: 8, totalCompleted: 8, cancelled: 2, pointsThisMonth: 0 },
      0
    );
    expect(s.completion_rate).toBe(80); // 8 / (8 + 2)
    expect(s.completion_component).toBe(24); // 0.8 * 30
  });
});

describe("isTripOnTime", () => {
  it("is on time when every stop is delivered on the pickup day", () => {
    const pickup = new Date("2026-06-24T01:00:00Z");
    const stops = [{ delivered_at: new Date("2026-06-24T06:00:00Z") }];
    expect(isTripOnTime(pickup, stops)).toBe(true);
  });

  it("is late when a stop spills into the next day", () => {
    const pickup = new Date("2026-06-24T01:00:00Z");
    const stops = [{ delivered_at: new Date("2026-06-25T01:00:00Z") }];
    expect(isTripOnTime(pickup, stops)).toBe(false);
  });

  it("ignores stops that have not been delivered yet", () => {
    const pickup = new Date("2026-06-24T01:00:00Z");
    const stops = [{ delivered_at: null }, { delivered_at: new Date("2026-06-24T05:00:00Z") }];
    expect(isTripOnTime(pickup, stops)).toBe(true);
  });
});
