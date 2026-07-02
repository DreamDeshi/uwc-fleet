import { describe, it, expect } from "vitest";
import {
  attentionConfig,
  hoursSince,
  isOverdueAssigned,
  isStaleInProgress,
} from "../src/services/attention";

/**
 * Stuck-trip attention predicates (read-only report). Staleness is measured
 * from pickup_datetime — started_at is not stored, so "N hours past pickup and
 * still not done" is the honest proxy.
 */

const NOW = new Date("2026-07-02T10:00:00Z");
const cfg = { staleInProgressHours: 8, overdueAssignedHours: 2 };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe("isStaleInProgress", () => {
  it("flags an in_progress trip whose pickup is past the threshold", () => {
    expect(isStaleInProgress({ status: "in_progress", pickup_datetime: hoursAgo(9) }, NOW, cfg)).toBe(true);
  });

  it("does not flag a recent in_progress trip or other statuses", () => {
    expect(isStaleInProgress({ status: "in_progress", pickup_datetime: hoursAgo(7) }, NOW, cfg)).toBe(false);
    expect(isStaleInProgress({ status: "assigned", pickup_datetime: hoursAgo(20) }, NOW, cfg)).toBe(false);
    expect(isStaleInProgress({ status: "completed", pickup_datetime: hoursAgo(20) }, NOW, cfg)).toBe(false);
  });
});

describe("isOverdueAssigned", () => {
  it("flags an assigned trip whose pickup is past the (shorter) threshold", () => {
    expect(isOverdueAssigned({ status: "assigned", pickup_datetime: hoursAgo(3) }, NOW, cfg)).toBe(true);
  });

  it("a future-dated assigned trip is never overdue", () => {
    expect(isOverdueAssigned({ status: "assigned", pickup_datetime: hoursAgo(-24) }, NOW, cfg)).toBe(false);
  });
});

describe("attentionConfig — env parsing with safe defaults", () => {
  it("falls back to defaults when env vars are unset/garbage", () => {
    const cfg = attentionConfig();
    expect(cfg.staleInProgressHours).toBeGreaterThan(0);
    expect(cfg.overdueAssignedHours).toBeGreaterThan(0);
  });
});

describe("hoursSince", () => {
  it("computes fractional hours", () => {
    expect(hoursSince(hoursAgo(1.5), NOW)).toBeCloseTo(1.5);
  });
});
