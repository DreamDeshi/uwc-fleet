import { describe, it, expect } from "vitest";
import {
  estimateOperatingWindow,
  parseHmToMinutes,
  formatMinutesToHm,
  OP_LOAD_MIN,
  OP_UNLOAD_MIN_PER_STOP,
  OP_DRIVE_MIN_PER_LEG,
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
  windowWraps,
  isWithinWindow,
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

  // ⚠ The two cases below used the FLEET DEFAULT end, which was 18:00 until
  // item 12 moved it to 02:00 (17 Jul 2026). They now pass an EXPLICIT 18:00
  // window: the non-wrapping path is still live for any truck an admin gives a
  // same-day window, so this coverage is kept rather than retired. The default
  // window's own (wrapping) behaviour is pinned in its own describe below.
  const END_1800 = { windowEnd: "18:00" };

  it("a run finishing 18:40 exceeds an explicit 18:00 window (completion_past_window)", () => {
    // pickup 17:05 MYT + 1h35m = 18:40.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 17, 5), stopCount: 1, ...END_1800 });
    expect(r.completionLabel).toBe("18:40");
    expect(r.exceedsWindow).toBe(true);
    expect(r.completionPastWindow).toBe(true);
    expect(r.pickupOutsideWindow).toBe(false);
    expect(r.reason).toBe("completion_past_window");
  });

  it("a completion landing exactly at 18:00 is allowed on an explicit 18:00 window (boundary, not past)", () => {
    // pickup 16:25 MYT + 1h35m = 18:00 exactly.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 16, 25), stopCount: 1, ...END_1800 });
    expect(r.completionLabel).toBe("18:00");
    expect(r.exceedsWindow).toBe(false);
  });

  it("a pickup at 06:30 (before 07:00) is flagged (pickup_outside_window)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 6, 30), stopCount: 1 });
    expect(r.exceedsWindow).toBe(true);
    expect(r.pickupOutsideWindow).toBe(true);
    expect(r.reason).toBe("pickup_outside_window");
  });

  it("a pickup after 18:00 is flagged on an explicit 18:00 window (pickup_outside_window)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 18, 30), stopCount: 1, ...END_1800 });
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

/**
 * Item 12 (Mr. Teh, 17 Jul 2026): "can pickup time allow set until 2AM instead
 * of 6pm". The default window therefore WRAPS midnight — an operating day runs
 * 07:00 → 02:00 the next calendar day — which the old `start <= t <= end` scan
 * could not express (it would have rejected every daytime pickup, 10:00 being
 * "after" 02:00).
 */
describe("operating-window — the default 07:00→02:00 window wraps past midnight", () => {
  it("defaults to the 07:00–02:00 window", () => {
    expect(DEFAULT_WINDOW_START).toBe("07:00");
    expect(DEFAULT_WINDOW_END).toBe("02:00");
  });

  it("windowWraps() is true for 07:00→02:00 and false for 07:00→18:00", () => {
    expect(windowWraps(7 * 60, 2 * 60)).toBe(true);
    expect(windowWraps(7 * 60, 18 * 60)).toBe(false);
  });

  it("an end EQUAL to the start does NOT wrap (degenerate, not 'open 24h')", () => {
    expect(windowWraps(7 * 60, 7 * 60)).toBe(false);
  });

  it("isWithinWindow() accepts BOTH halves of a wrapping day and rejects the gap", () => {
    const S = 7 * 60,
      E = 2 * 60;
    expect(isWithinWindow(7 * 60, S, E)).toBe(true); // 07:00 — opens
    expect(isWithinWindow(10 * 60, S, E)).toBe(true); // 10:00 — midday
    expect(isWithinWindow(23 * 60 + 59, S, E)).toBe(true); // 23:59 — evening half
    expect(isWithinWindow(0, S, E)).toBe(true); // 00:00 — small-hours half
    expect(isWithinWindow(2 * 60, S, E)).toBe(true); // 02:00 — closes
    expect(isWithinWindow(2 * 60 + 1, S, E)).toBe(false); // 02:01 — the gap
    expect(isWithinWindow(5 * 60, S, E)).toBe(false); // 05:00 — the gap
    expect(isWithinWindow(6 * 60 + 59, S, E)).toBe(false); // 06:59 — the gap
  });

  it("a midday pickup is INSIDE the wrapping window (the check the old scan broke on)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 10, 0), stopCount: 1 });
    expect(r.pickupOutsideWindow).toBe(false);
    expect(r.exceedsWindow).toBe(false);
  });

  it("a 22:00 pickup is allowed and its run is measured against 02:00 TOMORROW", () => {
    // 22:00 + 1h35m = 23:35 — comfortably inside a day that closes at 02:00.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 22, 0), stopCount: 1 });
    expect(r.pickupOutsideWindow).toBe(false);
    expect(r.completionPastWindow).toBe(false);
    expect(r.reason).toBe("ok");
  });

  it("an evening run spilling PAST midnight is now OK (it used to breach 18:00)", () => {
    // 23:00 + 1h35m = 00:35 next day. Under the old 18:00 window this was a
    // breach; the operating day now closes at 02:00, so it is within.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 23, 0), stopCount: 1 });
    expect(r.completionLabel).toBe("00:35");
    expect(r.exceedsWindow).toBe(false);
  });

  it("a 17:05 long-haul that used to breach 18:00 now auto-dispatches (the slack item 12 buys)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 17, 5), stopCount: 1 });
    expect(r.completionLabel).toBe("18:40");
    expect(r.exceedsWindow).toBe(false); // was true under the 18:00 window
  });

  it("DAY BOUNDARY: a 01:00 pickup belongs to YESTERDAY's shift, so it closes at 02:00 TODAY", () => {
    // This is the crux of "a 2AM pickup belongs to which operating day?". The
    // 01:00 pickup is the tail of the shift that opened 07:00 the previous
    // day, so it has one hour left — not 25. A naive same-day end would agree
    // here by luck; the next test is the one that separates them.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 7, 1, 0), stopCount: 1 });
    expect(r.pickupOutsideWindow).toBe(false); // 01:00 is inside the window…
    expect(r.completionLabel).toBe("02:35");
    expect(r.completionPastWindow).toBe(true); // …but 02:35 is past the 02:00 close
    expect(r.reason).toBe("completion_past_window");
  });

  it("DAY BOUNDARY: a 23:00 pickup does NOT close at 02:00 the same morning (23h in the past)", () => {
    // The naive reading — "end = 02:00 on the pickup's own MYT date" — would
    // put the deadline 21 hours BEFORE the pickup and flag every evening run.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 6, 23, 0), stopCount: 1 });
    expect(r.completionPastWindow).toBe(false);
    expect(r.estimatedCompletion.getTime()).toBe(myt(2026, 7, 7, 0, 35).getTime());
  });

  it("a 02:00 pickup (the latest allowed) is IN the window but its run breaches the close", () => {
    // Mr. Teh asked for pickups "until 2AM", and 02:00 is accepted as a pickup
    // time. The run itself then finishes at 03:35, past the 02:00 close, so it
    // surfaces as a completion warning for admin to force — the same shape an
    // 18:00 pickup had under the old window.
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 7, 2, 0), stopCount: 1 });
    expect(r.pickupOutsideWindow).toBe(false);
    expect(r.completionPastWindow).toBe(true);
    expect(r.reason).toBe("completion_past_window");
  });

  it("a 05:00 pickup falls in the CLOSED gap between 02:00 and 07:00", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 7, 5, 0), stopCount: 1 });
    expect(r.pickupOutsideWindow).toBe(true);
    expect(r.reason).toBe("pickup_outside_window");
  });

  it("closes correctly across a MONTH end (31 Jul 23:00 → 02:00 on 1 Aug)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 7, 31, 23, 0), stopCount: 1 });
    expect(r.completionPastWindow).toBe(false);
    expect(r.estimatedCompletion.getTime()).toBe(myt(2026, 8, 1, 0, 35).getTime());
  });

  it("closes correctly across a YEAR end (31 Dec 23:00 → 02:00 on 1 Jan)", () => {
    const r = estimateOperatingWindow({ pickupDateTime: myt(2026, 12, 31, 23, 0), stopCount: 1 });
    expect(r.completionPastWindow).toBe(false);
    expect(r.estimatedCompletion.getTime()).toBe(myt(2027, 1, 1, 0, 35).getTime());
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

describe("estimateOperatingWindow — zone-scaled drive legs (distance proxy)", () => {
  // All cases pin env-independent values explicitly: flat 45 min/leg, 30 load,
  // 20 unload, baseline 3 points (a 3-point zone = one flat leg).
  const base = {
    loadMin: 30,
    unloadMinPerStop: 20,
    driveMinPerLeg: 45,
    drivePointsBaseline: 3,
    windowStart: "07:00",
    windowEnd: "18:00",
  };
  const pickupMyt = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 8, h - 8, m)); // Wed MYT

  it("a 16:00 Ipoh run (6 pts → 90-min leg) now FLAGS: est. 18:20 past 18:00", () => {
    const est = estimateOperatingWindow({
      ...base,
      pickupDateTime: pickupMyt(16, 0),
      stopCount: 1,
      stopPoints: [6],
    });
    expect(est.addedMinutes).toBe(30 + 90 + 20);
    expect(est.completionLabel).toBe("18:20");
    expect(est.exceedsWindow).toBe(true);
    expect(est.reason).toBe("completion_past_window");
  });

  it("the same 16:00 run under the OLD flat estimate would have passed (17:35)", () => {
    const est = estimateOperatingWindow({ ...base, pickupDateTime: pickupMyt(16, 0), stopCount: 1 });
    expect(est.completionLabel).toBe("17:35");
    expect(est.exceedsWindow).toBe(false);
  });

  it("a 16:50 Juru hop (1 pt → 15-min leg) no longer over-warns: est. 17:55 in-window", () => {
    const est = estimateOperatingWindow({
      ...base,
      pickupDateTime: pickupMyt(16, 50),
      stopCount: 1,
      stopPoints: [1],
    });
    expect(est.addedMinutes).toBe(30 + 15 + 20);
    expect(est.completionLabel).toBe("17:55");
    expect(est.exceedsWindow).toBe(false);
  });

  it("multi-stop legs sum per-stop points: Juru (1) + Kulim (3) = 15 + 45 drive", () => {
    const est = estimateOperatingWindow({
      ...base,
      pickupDateTime: pickupMyt(10, 0),
      stopCount: 2,
      stopPoints: [1, 3],
    });
    expect(est.addedMinutes).toBe(30 + (15 + 45) + 2 * 20);
  });

  it("an unknown zone (null points) falls back to the flat leg", () => {
    const est = estimateOperatingWindow({
      ...base,
      pickupDateTime: pickupMyt(10, 0),
      stopCount: 2,
      stopPoints: [null, 6],
    });
    expect(est.addedMinutes).toBe(30 + (45 + 90) + 2 * 20);
  });
});
