import { describe, it, expect } from "vitest";
import { pickupToSlot, tripRemarks, PICKUP_HOURS, isPickupHour } from "./bookingEdit";

// Fixed "now": a Wednesday 10:30 local time.
const NOW = new Date(2026, 6, 15, 10, 30, 0, 0);

const iso = (dayOffset: number, hour: number, minute = 0) => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

describe("pickupToSlot — reversing a stored pickup into the form's buckets", () => {
  it("round-trips a representable pickup (tomorrow 09:00)", () => {
    expect(pickupToSlot(iso(1, 9), NOW)).toEqual({ dayOffset: 1, hour: 9 });
  });

  it("today later-hour pickup is representable", () => {
    expect(pickupToSlot(iso(0, 14), NOW)).toEqual({ dayOffset: 0, hour: 14 });
  });

  it("the picker-window edges (07:00 and 02:00, day 0 and day 6) are representable", () => {
    expect(pickupToSlot(iso(0, 18), NOW)).toEqual({ dayOffset: 0, hour: 18 });
    expect(pickupToSlot(iso(6, 8), NOW)).toEqual({ dayOffset: 6, hour: 8 });
    // 07:00 — the hour the fleet window has always opened, but which the old
    // 08..18 picker never offered.
    expect(pickupToSlot(iso(1, 7), NOW)).toEqual({ dayOffset: 1, hour: 7 });
    // 02:00 — the latest pickup, item 12.
    expect(pickupToSlot(iso(1, 2), NOW)).toEqual({ dayOffset: 1, hour: 2 });
  });

  it("the small hours past midnight are representable (the window wraps — item 12)", () => {
    expect(pickupToSlot(iso(1, 0), NOW)).toEqual({ dayOffset: 1, hour: 0 }); // 00:00
    expect(pickupToSlot(iso(1, 1), NOW)).toEqual({ dayOffset: 1, hour: 1 }); // 01:00
    expect(pickupToSlot(iso(1, 23), NOW)).toEqual({ dayOffset: 1, hour: 23 }); // 23:00
  });

  it("offers every hour of the operating day, in shift order, and nothing else", () => {
    expect(PICKUP_HOURS).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2]);
    expect(PICKUP_HOURS).toHaveLength(20);
    // The closed gap between the 02:00 close and the 07:00 open.
    for (const h of [3, 4, 5, 6]) expect(isPickupHour(h)).toBe(false);
  });

  it("a pickup on a PAST day is not representable (falls back to next bookable slot)", () => {
    expect(pickupToSlot(iso(-1, 9), NOW)).toBeNull();
  });

  it("today at an earlier hour is still representable — the day hasn't passed", () => {
    // The picker itself allows choosing 08:00 today at 10:30; the server only
    // rejects it if the pickup CHANGED. Keeping the stored value must win.
    expect(pickupToSlot(iso(0, 8), NOW)).toEqual({ dayOffset: 0, hour: 8 });
  });

  it("beyond the 7-day window is not representable", () => {
    expect(pickupToSlot(iso(7, 9), NOW)).toBeNull();
  });

  it("outside picker hours — the 02:00–07:00 closed gap — is not representable", () => {
    // 19:00 USED to be unrepresentable and now is not: the operating day runs
    // to 02:00 (item 12). What remains unbookable is the gap when the fleet is
    // shut, 03:00–06:00.
    expect(pickupToSlot(iso(1, 19), NOW)).toEqual({ dayOffset: 1, hour: 19 });
    expect(pickupToSlot(iso(1, 3), NOW)).toBeNull();
    expect(pickupToSlot(iso(1, 5), NOW)).toBeNull();
    expect(pickupToSlot(iso(1, 6), NOW)).toBeNull();
  });

  it("a non-whole-hour pickup is not representable", () => {
    expect(pickupToSlot(iso(1, 9, 30), NOW)).toBeNull();
  });

  it("garbage input is not representable", () => {
    expect(pickupToSlot("not-a-date", NOW)).toBeNull();
  });
});

describe("tripRemarks — remarks live on the first non-empty cargo-line remark", () => {
  it("returns the first non-empty remark", () => {
    expect(tripRemarks([{ remark: null }, { remark: "fragile" }])).toBe("fragile");
  });

  it("ignores whitespace-only remarks", () => {
    expect(tripRemarks([{ remark: "   " }, { remark: "call first" }])).toBe("call first");
  });

  it("returns empty string when there are none", () => {
    expect(tripRemarks([{ remark: null }])).toBe("");
    expect(tripRemarks([])).toBe("");
    expect(tripRemarks(undefined)).toBe("");
  });
});
