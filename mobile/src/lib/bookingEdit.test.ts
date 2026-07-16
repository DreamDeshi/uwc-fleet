import { describe, it, expect } from "vitest";
import { pickupToSlot, tripRemarks } from "./bookingEdit";

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

  it("the picker-window edges (08:00 and 18:00, day 0 and day 6) are representable", () => {
    expect(pickupToSlot(iso(0, 18), NOW)).toEqual({ dayOffset: 0, hour: 18 });
    expect(pickupToSlot(iso(6, 8), NOW)).toEqual({ dayOffset: 6, hour: 8 });
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

  it("outside picker hours is not representable", () => {
    expect(pickupToSlot(iso(1, 7), NOW)).toBeNull();
    expect(pickupToSlot(iso(1, 19), NOW)).toBeNull();
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
