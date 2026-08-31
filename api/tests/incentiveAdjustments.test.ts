import { describe, it, expect } from "vitest";
import {
  monthsBetweenKeys,
  isWithinAdjustmentWindow,
  INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK,
} from "../src/services/incentiveAdjustments";

describe("monthsBetweenKeys", () => {
  it("same month is 0", () => {
    expect(monthsBetweenKeys("2026-08", "2026-08")).toBe(0);
  });

  it("counts whole months forward", () => {
    expect(monthsBetweenKeys("2026-05", "2026-08")).toBe(3);
  });

  it("crosses a year boundary correctly", () => {
    expect(monthsBetweenKeys("2025-11", "2026-02")).toBe(3);
  });

  it("is negative when `to` is before `from`", () => {
    expect(monthsBetweenKeys("2026-08", "2026-05")).toBe(-3);
  });

  it("returns null for a malformed key on either side", () => {
    expect(monthsBetweenKeys("2026-8", "2026-08")).toBeNull();
    expect(monthsBetweenKeys("2026-08", "not-a-month")).toBeNull();
    expect(monthsBetweenKeys("", "2026-08")).toBeNull();
  });
});

describe("isWithinAdjustmentWindow (R6-3 — capped at 3 months back)", () => {
  it("the constant is 3, matching the owner's ruling verbatim", () => {
    expect(INCENTIVE_ADJUSTMENT_MAX_MONTHS_BACK).toBe(3);
  });

  it("the CURRENT month is always adjustable", () => {
    expect(isWithinAdjustmentWindow("2026-08", "2026-08")).toBe(true);
  });

  it("exactly 3 months back is still allowed (the boundary is inclusive)", () => {
    expect(isWithinAdjustmentWindow("2026-05", "2026-08")).toBe(true);
  });

  it("⚠ 4 months back is refused — one past the boundary, not the boundary itself", () => {
    expect(isWithinAdjustmentWindow("2026-04", "2026-08")).toBe(false);
  });

  it("a trip dated in the future relative to now is refused, not treated as 'always fresh'", () => {
    expect(isWithinAdjustmentWindow("2026-09", "2026-08")).toBe(false);
  });

  it("a malformed key on either side refuses closed, never silently allows", () => {
    expect(isWithinAdjustmentWindow("garbage", "2026-08")).toBe(false);
    expect(isWithinAdjustmentWindow("2026-08", "garbage")).toBe(false);
  });
});
