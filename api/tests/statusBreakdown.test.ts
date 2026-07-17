import { describe, it, expect } from "vitest";
import type { TripStatus } from "@prisma/client";
import { breakdownTotal, statusBreakdown } from "../src/lib/statusBreakdown";

const ALL_STATUSES: TripStatus[] = [
  "pending",
  "approved",
  "rejected",
  "assigned",
  "in_progress",
  "pending_approval",
  "completed",
  "cancelled",
];

describe("the sum contract", () => {
  it("REGRESSION: buckets sum to total with a pending_approval trip present", () => {
    // The defect: `pending_approval` matched no arm, so it was counted in NO
    // bucket. The client sums these five to get its own total, so the trip did
    // not merely go uncounted — it shrank the denominator.
    const trips: TripStatus[] = ["completed", "pending_approval", "in_progress"];
    const breakdown = statusBreakdown(trips);

    expect(breakdownTotal(breakdown)).toBe(trips.length);
    expect(breakdown.completed).toBe(2); // completed + pending_approval
  });

  it("holds for EVERY status — no member of the union goes uncounted", () => {
    // The general form of the bug: any status with no arm silently vanishes.
    const breakdown = statusBreakdown(ALL_STATUSES);
    expect(breakdownTotal(breakdown)).toBe(ALL_STATUSES.length);
  });

  it("a requestor whose ONLY trips await approval is not shown an empty state", () => {
    // Pre-fix this returned all-zeros, so the client's derived total was 0 and
    // AnalyticsScreen rendered "No data yet" to a requestor with real trips.
    const breakdown = statusBreakdown(["pending_approval", "pending_approval"]);
    expect(breakdownTotal(breakdown)).toBe(2);
    expect(breakdown.completed).toBe(2);
  });

  it("is empty for no trips", () => {
    expect(breakdownTotal(statusBreakdown([]))).toBe(0);
  });
});

describe("the documented folds", () => {
  it("folds pending_approval into completed — the goods arrived", () => {
    expect(statusBreakdown(["pending_approval"]).completed).toBe(1);
  });

  it("folds approved into pending", () => {
    expect(statusBreakdown(["approved", "pending"]).pending).toBe(2);
  });

  it("folds rejected into cancelled", () => {
    expect(statusBreakdown(["rejected", "cancelled"]).cancelled).toBe(2);
  });

  it("keeps assigned and in_progress distinct", () => {
    const b = statusBreakdown(["assigned", "in_progress", "in_progress"]);
    expect(b.assigned).toBe(1);
    expect(b.in_progress).toBe(2);
  });
});
