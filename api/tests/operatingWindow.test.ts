import { describe, it, expect } from "vitest";
import {
  estimateOperatingWindow,
  parseHmToMinutes,
  formatMinutesToHm,
  OP_LOAD_MIN,
  OP_UNLOAD_MIN_PER_STOP,
  OP_DRIVE_MIN_PER_LEG,
} from "../src/services/operatingWindow";

// Build a UTC instant from a Malaysia-time (UTC+8) wall clock, so tests read in
// MYT regardless of where they run. 2026-07-06 is a Monday.
function myt(year: number, month1: number, day: number, hour: number, min = 0): Date {
  return new Date(Date.UTC(year, month1 - 1, day, hour, min) - 8 * 60 * 60 * 1000);
}

describe("operating-window estimate (defaults 30 / 45 / 20)", () => {
  // 1 stop ⇒ added = 30 (load) + 1×45 (drive) + 1×20 (unload) = 95 min = 1h35m.
  it("uses the documented default minutes", () => {
    expect(OP_LOAD_MIN).toBe(30);
    expect(OP_DRIVE_MIN_PER_LEG).toBe(45);
    expect(OP_UNLOAD_MIN_PER_STOP).toBe(20);
  });

  it("a run finishing 17:30 is within the 18:00 window (ok)", () => {
    // pickup 15:55 MYT + 1h35m = 17:30.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 15, 55), stopCount: 1 });
    expect(r.completionLabel).toBe("17:30");
    expect(r.exceedsWindow).toBe(false);
    expect(r.reason).toBe("ok");
  });

  it("a run finishing 18:40 exceeds the window (completion_past_window)", () => {
    // pickup 17:05 MYT + 1h35m = 18:40.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 17, 5), stopCount: 1 });
    expect(r.completionLabel).toBe("18:40");
    expect(r.exceedsWindow).toBe(true);
    expect(r.completionPastWindow).toBe(true);
    expect(r.pickupOutsideWindow).toBe(false);
    expect(r.reason).toBe("completion_past_window");
  });

  it("a completion landing exactly at 18:00 is allowed (boundary, not past)", () => {
    // pickup 16:25 MYT + 1h35m = 18:00 exactly.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 16, 25), stopCount: 1 });
    expect(r.completionLabel).toBe("18:00");
    expect(r.exceedsWindow).toBe(false);
  });

  it("a pickup at 06:30 (before 07:00) is flagged (pickup_outside_window)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 6, 30), stopCount: 1 });
    expect(r.exceedsWindow).toBe(true);
    expect(r.pickupOutsideWindow).toBe(true);
    expect(r.reason).toBe("pickup_outside_window");
  });

  it("a pickup after 18:00 is flagged (pickup_outside_window)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 18, 30), stopCount: 1 });
    expect(r.exceedsWindow).toBe(true);
    expect(r.reason).toBe("pickup_outside_window");
  });

  it("legs scale with the stop count (base→s1→…→sN = N legs, N unloads)", () => {
    // 3 stops ⇒ 30 + 3×45 + 3×20 = 225 min = 3h45m.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 8, 0), stopCount: 3 });
    expect(r.addedMinutes).toBe(225);
    expect(r.completionLabel).toBe("11:45");
    expect(r.exceedsWindow).toBe(false);
  });
});

describe("operating-window — MYT (UTC+8) explicit, never server-local", () => {
  it("bins by Malaysia wall clock across a UTC day boundary", () => {
    // 2026-07-06 23:00 UTC = 2026-07-07 07:00 MYT. 1 stop → 08:35 MYT, within window.
    const pickup = new Date(Date.UTC(2026, 6, 6, 23, 0));
    const r = estimateOperatingWindow({ pickupDateTime: pickup, stopCount: 1 });
    expect(r.pickupMinutesMyt).toBe(7 * 60); // 07:00 MYT
    expect(r.completionLabel).toBe("08:35");
    expect(r.exceedsWindow).toBe(false);
  });
});

describe("operating-window — configurable params & per-truck window", () => {
  it("honours overridden estimate minutes", () => {
    const r = estimateOperatingWindow({
      pickupDateTime: myt(2026, 7, 6, 9, 0),
      stopCount: 2,
      loadMin: 0,
      driveMinPerLeg: 30,
      unloadMinPerStop: 0,
    });
    expect(r.addedMinutes).toBe(60); // 0 + 2×30 + 0
    expect(r.completionLabel).toBe("10:00");
  });

  it("respects a wider per-truck operating window", () => {
    // 18:40 completion is past 18:00 but within a 20:00 window.
    const r = estimateOperatingWindow({
      pickupDateTime: myt(2026, 7, 6, 17, 5),
      stopCount: 1,
      windowEnd: "20:00",
    });
    expect(r.completionLabel).toBe("18:40");
    expect(r.exceedsWindow).toBe(false);
  });
});

describe("HH:MM parsing/formatting helpers", () => {
  it("parses valid HH:MM and falls back on garbage", () => {
    expect(parseHmToMinutes("07:00", -1)).toBe(420);
    expect(parseHmToMinutes("18:30", -1)).toBe(1110);
    expect(parseHmToMinutes("", 99)).toBe(99);
    expect(parseHmToMinutes("nope", 99)).toBe(99);
    expect(parseHmToMinutes("25:00", 99)).toBe(99); // hour out of range
  });

  it("formats minutes-from-midnight as zero-padded HH:MM", () => {
    expect(formatMinutesToHm(420)).toBe("07:00");
    expect(formatMinutesToHm(1110)).toBe("18:30");
    expect(formatMinutesToHm(5)).toBe("00:05");
  });
});
