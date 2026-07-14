import { describe, it, expect } from "vitest";
import { PUBLIC_HOLIDAYS_2026 } from "../src/data/publicHolidays2026";
import { isOffPeak } from "../src/services/incentiveEngine";

/**
 * Phase 1 (MONEY) — a regression guard on the 2026 public-holiday DATA that
 * drives the off-peak rate tier. The source file itself warns that the old
 * engine once shipped 2025's calendar relabeled as 2026, and that the Islamic
 * (moon-sighting) dates need JAKIM-gazette verification.
 *
 * This test does NOT claim the Islamic estimates are correct (they still need a
 * human check before go-live — see below). It locks:
 *   - the FIXED-date national holidays to their known-correct dates,
 *   - structural integrity (no duplicates, all valid 2026 keys),
 *   - that a holiday actually drives isOffPeak → off-peak on a weekday,
 *   - the current estimated Islamic dates, so any change to them is DELIBERATE
 *     and re-triggers verification rather than drifting silently.
 */

const dates = PUBLIC_HOLIDAYS_2026.map((h) => h.date);
const dateSet = new Set(dates);

describe("PUBLIC_HOLIDAYS_2026 — structural integrity", () => {
  it("has no duplicate dates", () => {
    expect(dateSet.size).toBe(dates.length);
  });

  it("every entry is a valid YYYY-MM-DD key in the year 2026", () => {
    for (const d of dates) {
      expect(d).toMatch(/^2026-\d{2}-\d{2}$/);
      const parsed = new Date(`${d}T00:00:00Z`);
      expect(Number.isNaN(parsed.getTime())).toBe(false);
      expect(parsed.getUTCFullYear()).toBe(2026);
    }
  });

  it("locks the row count (a change to the calendar must be deliberate)", () => {
    expect(PUBLIC_HOLIDAYS_2026.length).toBe(19);
  });
});

describe("PUBLIC_HOLIDAYS_2026 — the fixed-date national holidays", () => {
  // These have legally fixed calendar dates every year — safe to assert exactly.
  it.each([
    ["2026-01-01", "New Year's Day"],
    ["2026-05-01", "Labour Day"],
    ["2026-08-31", "Merdeka Day"],
    ["2026-09-16", "Malaysia Day"],
    ["2026-12-25", "Christmas Day"],
  ])("includes %s (%s)", (date) => {
    expect(dateSet.has(date)).toBe(true);
  });
});

describe("PUBLIC_HOLIDAYS_2026 — drives the off-peak rate tier", () => {
  it("a public holiday makes a WEEKDAY MIDDAY off-peak (and it's the holiday, not the hour)", () => {
    // New Year's Day 2026-01-01 is a Thursday. At midday a plain weekday is
    // PEAK; the holiday is what flips it to off-peak.
    const newYearMidday = new Date(Date.UTC(2026, 0, 1, 12 - 8, 0));
    expect(isOffPeak(newYearMidday, dateSet)).toBe(true); // holiday → off-peak
    expect(isOffPeak(newYearMidday, new Set())).toBe(false); // same instant, no holiday → peak
  });
});

describe("PUBLIC_HOLIDAYS_2026 — UNVERIFIED Islamic estimates (lock for re-review)", () => {
  // ⚠ These moon-sighting dates are ESTIMATES pending JAKIM-gazette verification
  // before the UWC trial. Locking the current values means any correction is a
  // deliberate edit that re-runs this test — it does NOT assert they are right.
  it.each([
    ["2026-03-21", "Hari Raya Aidilfitri"],
    ["2026-05-27", "Hari Raya Aidiladha"],
    ["2026-06-16", "Awal Muharram"],
    ["2026-08-25", "Maulidur Rasul"],
  ])("currently lists %s (%s) — verify vs JAKIM before go-live", (date) => {
    expect(dateSet.has(date)).toBe(true);
  });
});
