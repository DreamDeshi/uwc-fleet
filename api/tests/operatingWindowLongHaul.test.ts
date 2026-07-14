import { describe, it, expect } from "vitest";
import { estimateOperatingWindow } from "../src/services/operatingWindow";

/**
 * Phase 2 (DISPATCH) — the 8-point long-haul window tier (KL / JH / SL).
 *
 * The existing operatingWindow tests exercise 1-point (Juru) and 6-point (Ipoh)
 * legs; the newer long-haul zones score 8, which scales a drive leg to
 * round(45 × 8/3) = 120 minutes. A single-stop long-haul run therefore adds
 * 30 (load) + 120 (drive) + 20 (unload) = 170 minutes — enough to spill past an
 * 18:00 window from a mid-afternoon pickup. Pure; no DB.
 */

// A given MYT hour on a weekday (2026-07-15 = Wednesday), as a UTC instant.
function mytPickup(hour: number): Date {
  return new Date(Date.UTC(2026, 6, 15, hour - 8, 0));
}

describe("estimateOperatingWindow — 8-point long-haul leg (KL/JH/SL)", () => {
  it("scales a single 8-point leg to 120 minutes (170 total added)", () => {
    const est = estimateOperatingWindow({
      pickupDateTime: mytPickup(9),
      stopCount: 1,
      stopPoints: [8],
      windowStart: "07:00",
      windowEnd: "18:00",
    });
    expect(est.addedMinutes).toBe(170); // 30 + 120 + 20
  });

  it("a 09:00 long-haul run finishes 11:50 — inside the 07:00–18:00 window", () => {
    const est = estimateOperatingWindow({
      pickupDateTime: mytPickup(9),
      stopCount: 1,
      stopPoints: [8],
      windowEnd: "18:00",
    });
    expect(est.completionLabel).toBe("11:50");
    expect(est.exceedsWindow).toBe(false);
    expect(est.reason).toBe("ok");
  });

  it("a 16:00 long-haul run finishes 18:50 — PAST the window (auto skips + flags)", () => {
    const est = estimateOperatingWindow({
      pickupDateTime: mytPickup(16),
      stopCount: 1,
      stopPoints: [8],
      windowEnd: "18:00",
    });
    expect(est.completionLabel).toBe("18:50");
    expect(est.exceedsWindow).toBe(true);
    expect(est.reason).toBe("completion_past_window");
  });

  it("an 8-point leg is materially longer than the 3-point baseline leg", () => {
    const long = estimateOperatingWindow({ pickupDateTime: mytPickup(9), stopCount: 1, stopPoints: [8] });
    const base = estimateOperatingWindow({ pickupDateTime: mytPickup(9), stopCount: 1, stopPoints: [3] });
    expect(long.addedMinutes - base.addedMinutes).toBe(75); // 120min leg − 45min baseline leg
  });
});
