import { describe, it, expect } from "vitest";
import {
  bookableHours,
  bookableMinutes,
  clampSlotToDay,
  dateForOffset,
  dayOffsetOf,
  dialIndexToHour,
  hourDialIndex,
  isDayBookable,
  isMonthReachable,
  maxBookableDate,
  meridiemOf,
  monthGrid,
  nextBookableSlot,
  sameDay,
  slotToDate,
} from "./pickupCalendar";
import { PICKUP_MAX_DAY_OFFSET } from "./bookingEdit";

// A Wednesday, 15 July 2026, 10:30 local.
const NOW = new Date(2026, 6, 15, 10, 30, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 6, 15, h, m, 0, 0);

describe("bookableHours — the fleet window minus what has already gone", () => {
  it("a future date offers the whole window and nothing outside it", () => {
    const hours = bookableHours(dateForOffset(NOW, 1), NOW);
    expect(hours).toEqual([0, 1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    // The fleet is shut 03:00–06:00 — the closed gap, on every date.
    for (const closed of [3, 4, 5, 6]) expect(hours).not.toContain(closed);
  });

  it("today drops the hours already past, and keeps the current one", () => {
    const hours = bookableHours(dateForOffset(NOW, 0), NOW);
    expect(hours).not.toContain(9); // gone
    expect(hours).toContain(10); // the current hour still has 10:35 onward
    expect(hours).toContain(23);
    // The small hours belong to THIS calendar date and are long past at 10:30.
    for (const past of [0, 1, 2]) expect(hours).not.toContain(past);
  });
});

describe("bookableMinutes", () => {
  it("gives a full ring for any hour that is entirely ahead", () => {
    expect(bookableMinutes(dateForOffset(NOW, 0), 14, NOW)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it("trims the CURRENT hour to what is still ahead", () => {
    expect(bookableMinutes(dateForOffset(NOW, 0), 10, NOW)).toEqual([35, 40, 45, 50, 55]);
  });

  it("is empty for a past hour, a closed hour, and a past date", () => {
    expect(bookableMinutes(dateForOffset(NOW, 0), 8, NOW)).toEqual([]);
    expect(bookableMinutes(dateForOffset(NOW, 1), 4, NOW)).toEqual([]);
    expect(bookableMinutes(dateForOffset(NOW, -1), 14, NOW)).toEqual([]);
  });

  it("is empty past the year cap", () => {
    expect(bookableMinutes(dateForOffset(NOW, PICKUP_MAX_DAY_OFFSET + 1), 14, NOW)).toEqual([]);
  });
});

describe("isDayBookable", () => {
  it("today is bookable while any slot remains, and stops being so once none does", () => {
    expect(isDayBookable(dateForOffset(NOW, 0), NOW)).toBe(true);
    // 23:57 — the last 5-minute slot of the day (23:55) has gone, and the
    // small hours of THIS date are 22 hours behind us.
    const lateNight = at(23, 57);
    expect(isDayBookable(dateForOffset(lateNight, 0), lateNight)).toBe(false);
    expect(isDayBookable(dateForOffset(lateNight, 1), lateNight)).toBe(true);
  });

  it("yesterday never is, and the last day of the year window still is", () => {
    expect(isDayBookable(dateForOffset(NOW, -1), NOW)).toBe(false);
    expect(isDayBookable(dateForOffset(NOW, PICKUP_MAX_DAY_OFFSET), NOW)).toBe(true);
    expect(isDayBookable(dateForOffset(NOW, PICKUP_MAX_DAY_OFFSET + 1), NOW)).toBe(false);
  });
});

describe("nextBookableSlot — the form's default pickup", () => {
  it("keeps an hour of lead rather than offering a pickup minutes away", () => {
    // 10:30 + 60min lead = 11:30. Not 10:35, which nobody could meet.
    expect(nextBookableSlot(NOW)).toEqual({ dayOffset: 0, hour: 11, minute: 30 });
  });

  it("crosses the closed 03:00–06:00 gap to the 07:00 open", () => {
    const preDawn = at(3, 40);
    expect(nextBookableSlot(preDawn)).toEqual({ dayOffset: 0, hour: 7, minute: 0 });
  });

  it("stays inside the small hours when they are still ahead (the window wraps)", () => {
    const midnight = at(0, 10);
    expect(nextBookableSlot(midnight)).toEqual({ dayOffset: 0, hour: 1, minute: 10 });
  });

  it("rolls to the next calendar day when today's window has closed", () => {
    const lateNight = at(23, 20);
    // 23:20 + 1h = 00:20 — hour 0 of TOMORROW, still inside the same shift.
    expect(nextBookableSlot(lateNight)).toEqual({ dayOffset: 1, hour: 0, minute: 20 });
  });

  it("honours a shorter lead when asked", () => {
    expect(nextBookableSlot(NOW, 0)).toEqual({ dayOffset: 0, hour: 10, minute: 35 });
  });
});

describe("clampSlotToDay — moving the DATE must not strand the time", () => {
  it("leaves a still-valid slot alone", () => {
    const slot = { dayOffset: 1, hour: 8, minute: 15 };
    expect(clampSlotToDay(slot, NOW)).toEqual(slot);
  });

  it("pulls a now-past time forward when the date moves to today", () => {
    // "08:00" was fine on tomorrow; on today at 10:30 it is six hours gone.
    const moved = clampSlotToDay({ dayOffset: 0, hour: 8, minute: 0 }, NOW);
    expect(moved.dayOffset).toBe(0);
    expect(moved.hour).toBeGreaterThanOrEqual(10);
    expect(bookableMinutes(dateForOffset(NOW, moved.dayOffset), moved.hour, NOW)).toContain(
      moved.minute
    );
  });

  it("keeps the hour and only nudges the minute when the hour survives", () => {
    expect(clampSlotToDay({ dayOffset: 0, hour: 10, minute: 0 }, NOW)).toEqual({
      dayOffset: 0,
      hour: 10,
      minute: 35,
    });
  });

  it("falls back to the next bookable slot when the day has nothing left", () => {
    const lateNight = at(23, 57);
    const moved = clampSlotToDay({ dayOffset: 0, hour: 14, minute: 0 }, lateNight);
    expect(moved).toEqual(nextBookableSlot(lateNight));
    expect(slotToDate(lateNight, moved).getTime()).toBeGreaterThan(+lateNight);
  });
});

describe("slotToDate / dayOffsetOf round-trip", () => {
  it("builds the instant the form submits", () => {
    const d = slotToDate(NOW, { dayOffset: 2, hour: 14, minute: 45 });
    expect(d.getDate()).toBe(17);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(45);
    expect(dayOffsetOf(d, NOW)).toBe(2);
  });

  it("maxBookableDate is a year out", () => {
    expect(dayOffsetOf(maxBookableDate(NOW), NOW)).toBe(PICKUP_MAX_DAY_OFFSET);
  });
});

describe("monthGrid — Monday-first, blanks keep the columns honest", () => {
  it("pads July 2026 (the 1st is a Wednesday) with two leading blanks", () => {
    const cells = monthGrid(2026, 6);
    expect(cells.slice(0, 2).every((c) => c.date === null)).toBe(true);
    expect(cells[2].date?.getDate()).toBe(1);
    expect(cells).toHaveLength(2 + 31);
  });

  it("pads a month starting on Sunday with six leading blanks, not none", () => {
    // 1 Feb 2026 is a Sunday — the Sunday-first getDay() of 0 would place it in
    // column 0 (Monday) without the shift.
    const cells = monthGrid(2026, 1);
    expect(cells.slice(0, 6).every((c) => c.date === null)).toBe(true);
    expect(cells[6].date?.getDate()).toBe(1);
  });

  it("gets February right in a leap year", () => {
    expect(monthGrid(2028, 1).filter((c) => c.date).length).toBe(29);
  });
});

describe("isMonthReachable — the calendar's ‹ › arrows", () => {
  it("allows this month and the last month inside the year window", () => {
    expect(isMonthReachable(2026, 6, NOW)).toBe(true);
    expect(isMonthReachable(2027, 6, NOW)).toBe(true);
  });

  it("refuses the month before this one, and anything past the cap", () => {
    expect(isMonthReachable(2026, 5, NOW)).toBe(false);
    expect(isMonthReachable(2027, 8, NOW)).toBe(false);
  });
});

describe("dial geometry", () => {
  it("maps 24h hours onto the 12-position ring with 12 at the top", () => {
    expect(hourDialIndex(12)).toBe(0);
    expect(hourDialIndex(0)).toBe(0);
    expect(hourDialIndex(14)).toBe(2);
    expect(hourDialIndex(23)).toBe(11);
  });

  it("reads a tapped position back as the right 24h hour", () => {
    expect(dialIndexToHour(0, "AM")).toBe(0); // 12 AM = midnight
    expect(dialIndexToHour(0, "PM")).toBe(12); // 12 PM = noon
    expect(dialIndexToHour(2, "PM")).toBe(14);
    expect(dialIndexToHour(11, "AM")).toBe(11);
  });

  it("round-trips every hour of the fleet window", () => {
    for (let h = 0; h < 24; h++) {
      expect(dialIndexToHour(hourDialIndex(h), meridiemOf(h))).toBe(h);
    }
  });
});

describe("sameDay", () => {
  it("compares the calendar date, not the instant", () => {
    expect(sameDay(at(1), at(23))).toBe(true);
    expect(sameDay(at(23), dateForOffset(NOW, 1))).toBe(false);
  });
});
