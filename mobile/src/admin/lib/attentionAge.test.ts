import { describe, expect, it } from "vitest";
import { pickupAge } from "./attentionAge";

// A fake t() that returns the KEY plus its interpolation values, so each
// assertion pins which string was chosen AND what was put in it. Asserting on
// rendered English would pass even if the code picked the hours key and merely
// happened to read plausibly.
const t = (key: string, opts?: Record<string, unknown>) =>
  `${key}(${JSON.stringify(opts ?? {})})`;

const PICKUP = "2026-08-01T09:00:00.000Z";

describe("pickupAge — hours are only readable while they are countable", () => {
  it("keeps hours below the two-day cutoff", () => {
    expect(pickupAge(8, PICKUP, t)).toBe('admin.dashboard.sincePickup({"h":8})');
    expect(pickupAge(47, PICKUP, t)).toBe('admin.dashboard.sincePickup({"h":47})');
  });

  // THE BUG THIS EXISTS FOR: 108h. It is the value that was on screen, and it
  // is the one a reader cannot convert. If the cutoff regressed to "never
  // switch", this is the case that goes red.
  it("switches to DAYS at 48h — 108h is four and a half days, not a number to divide", () => {
    expect(pickupAge(48, PICKUP, t)).toBe('admin.dashboard.sincePickupDays({"count":2})');
    expect(pickupAge(108, PICKUP, t)).toBe('admin.dashboard.sincePickupDays({"count":5})');
  });

  it("switches to the DATE past a fortnight, where a day count stops helping", () => {
    expect(pickupAge(24 * 14, PICKUP, t)).toContain("admin.dashboard.pickupOnDate");
    expect(pickupAge(24 * 40, PICKUP, t)).toContain("admin.dashboard.pickupOnDate");
  });

  // Without a timestamp the date branch cannot render. Falling back to days is
  // right; emitting an empty date would read as missing data.
  it("falls back to days when the date branch has no timestamp to show", () => {
    expect(pickupAge(24 * 40, null, t)).toBe('admin.dashboard.sincePickupDays({"count":40})');
  });

  describe("a pickup still in the future keeps its direction at every scale", () => {
    it("hours", () => {
      expect(pickupAge(-6, PICKUP, t)).toBe('admin.dashboard.untilPickup({"h":6})');
    });
    it("days", () => {
      expect(pickupAge(-72, PICKUP, t)).toBe('admin.dashboard.untilPickupDays({"count":3})');
    });
  });

  it("uses the singular key at exactly one day either side", () => {
    // i18next picks _one/_other from count; these assert the count it is given,
    // which is what drives that choice.
    expect(pickupAge(-24 * 1.02, PICKUP, t)).toBe('admin.dashboard.untilPickup({"h":24})');
    expect(pickupAge(49, PICKUP, t)).toBe('admin.dashboard.sincePickupDays({"count":2})');
  });
});
