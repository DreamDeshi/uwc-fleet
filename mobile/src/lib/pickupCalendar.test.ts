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
  cutoffClosedAt,
  slotNeedsCutoffOverride,
  isMonthReachable,
  maxBookableDate,
  meridiemOf,
  monthGrid,
  nextBookableSlot,
  sameDay,
  slotToDate,
} from "./pickupCalendar";
import {
  AFTERNOON_CUTOFF_MIN,
  MORNING_CUTOFF_MIN,
  PICKUP_MAX_DAY_OFFSET,
  SESSION_SPLIT_MIN,
} from "./bookingEdit";

// A Wednesday, 15 July 2026, 10:30 local.
const NOW = new Date(2026, 6, 15, 10, 30, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 6, 15, h, m, 0, 0);
/** NOW's own calendar date — B7 gates today and nothing else. */
const TODAY = new Date(2026, 6, 15, 0, 0, 0, 0);

describe("bookableHours — the fleet window minus what has already gone", () => {
  it("a future date offers the whole window and nothing outside it", () => {
    const hours = bookableHours(dateForOffset(NOW, 1), NOW);
    expect(hours).toEqual([0, 1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    // The fleet is shut 03:00–06:00 — the closed gap, on every date.
    for (const closed of [3, 4, 5, 6]) expect(hours).not.toContain(closed);
  });

  it("today drops the hours already past, and keeps the current one", () => {
    // ⚠ FIXTURE MOVED (12 Aug 2026, B7). This case is about rule (2), THE PAST,
    // and used to read it at 10:30 against the morning. B7's rule (3) now shuts
    // today's whole morning at 08:30, so a morning fixture would be measuring
    // the cut-off rather than the past-trim. Restated in the AFTERNOON, where
    // rule (2) is still the only thing acting — the assertion is unchanged in
    // substance: the hour containing NOW survives, earlier ones do not.
    // Read as a RETURN, which B7 exempts — that isolates rule (2) from rule
    // (3) exactly, instead of measuring the two together.
    const afternoon = at(15, 30);
    const hours = bookableHours(dateForOffset(afternoon, 0), afternoon, { isReturn: true });
    expect(hours).not.toContain(14); // gone
    expect(hours).toContain(15); // the current hour still has 15:35 onward
    expect(hours).toContain(23);
    // The small hours belong to THIS calendar date and are long past.
    for (const past of [0, 1, 2]) expect(hours).not.toContain(past);
    // …and for a DELIVERY at the same instant, nothing today survives at all:
    // both cut-offs have passed, which is exactly what B7 asks for.
    expect(bookableHours(dateForOffset(afternoon, 0), afternoon)).toEqual([]);
  });
});

describe("bookableMinutes", () => {
  it("gives a full ring for any hour that is entirely ahead", () => {
    expect(bookableMinutes(dateForOffset(NOW, 0), 14, NOW)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  it("trims the CURRENT hour to what is still ahead", () => {
    // Fixture moved into the afternoon for the same reason as above: at 10:30
    // hour 10 is now closed by B7, so this would no longer be reading the
    // past-trim it exists to read.
    const afternoon = at(15, 30);
    const ret = { isReturn: true };
    expect(bookableMinutes(dateForOffset(afternoon, 0), 15, afternoon, ret)).toEqual([35, 40, 45, 50, 55]);
    // The past still applies to a return — B7 exempts the CUT-OFF, not the
    // clock — which is what keeps the two rules distinguishable.
    expect(bookableMinutes(dateForOffset(afternoon, 0), 14, afternoon, ret)).toEqual([]);
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
    // Stated as a RETURN so the LEAD is the only rule acting: for a delivery at
    // 10:30 the morning is shut by B7, which is a different question, pinned
    // in its own case below.
    expect(nextBookableSlot(NOW, 60, { isReturn: true })).toEqual({ dayOffset: 0, hour: 11, minute: 30 });
  });

  it("B7 — a DELIVERY at 10:30 defaults into the AFTERNOON, the first open slot", () => {
    // The new behaviour, pinned explicitly rather than left as a side effect of
    // the case above: today's morning is closed, the afternoon is not.
    expect(nextBookableSlot(NOW)).toEqual({ dayOffset: 0, hour: 12, minute: 0 });
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
    expect(nextBookableSlot(NOW, 0, { isReturn: true })).toEqual({ dayOffset: 0, hour: 10, minute: 35 });
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
    // As a RETURN, so the minute-nudge is the only rule acting — for a
    // delivery at 10:30 hour 10 is closed by B7 and the slot moves further,
    // which the B7 block below pins separately.
    expect(clampSlotToDay({ dayOffset: 0, hour: 10, minute: 0 }, NOW, { isReturn: true })).toEqual({
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

/**
 * B7 — THE CALENDAR MUST NOT OFFER WHAT THE SERVER WILL REFUSE.
 *
 * The server rejects a booking made after 08:30 for a morning pickup, or after
 * 13:30 for an afternoon one (api/src/lib/bookingCutoff.ts). Shipping that
 * without this half would mean a requestor picking a time the app showed them
 * and getting an error — on the main booking path, on the build the client is
 * looking at. Both halves ship together or neither does (owner, 12 Aug 2026).
 *
 * NOW in this file is 10:30, which is past the morning cut-off and before the
 * afternoon one — so today's morning is shut and today's afternoon is open, and
 * every case below can be stated without moving the clock.
 */
describe("B7 — today's sessions close", () => {
  it("offers NO morning hour today once 08:30 has passed", () => {
    // 11:00 is still ahead of NOW (10:30) and inside the window, so only the
    // cut-off can be removing it. Without rule (3) this ring is full.
    expect(bookableMinutes(TODAY, 11, NOW)).toEqual([]);
    expect(bookableHours(TODAY, NOW).some((h) => h < 12)).toBe(false);
  });

  it("still offers the AFTERNOON today at 10:30 — the sessions are independent", () => {
    expect(bookableMinutes(TODAY, 15, NOW).length).toBeGreaterThan(0);
    expect(bookableHours(TODAY, NOW)).toContain(15);
  });

  it("shuts the afternoon too once 13:30 has passed, and today leaves the calendar", () => {
    const afterBoth = at(14, 0);
    expect(bookableMinutes(TODAY, 15, afterBoth)).toEqual([]);
    expect(bookableHours(TODAY, afterBoth)).toEqual([]);
    // The whole point: the day is no longer selectable, rather than selectable
    // and then rejected.
    expect(isDayBookable(TODAY, afterBoth)).toBe(false);
  });

  it("leaves TOMORROW untouched at any hour — only today is gated", () => {
    const tomorrow = dateForOffset(NOW, 1);
    for (const clock of [at(9, 0), at(14, 0), at(23, 30)]) {
      expect(bookableMinutes(tomorrow, 9, clock).length).toBeGreaterThan(0);
      expect(isDayBookable(tomorrow, clock)).toBe(true);
    }
  });

  it("EXEMPTS a return booking — his own sentence, 'anytime before 12am'", () => {
    const afterBoth = at(14, 0);
    const ret = { isReturn: true };
    expect(bookableMinutes(TODAY, 15, afterBoth, ret).length).toBeGreaterThan(0);
    expect(isDayBookable(TODAY, afterBoth, ret)).toBe(true);
    // …and the past rule still applies to a return: 09:00 has gone.
    expect(bookableMinutes(TODAY, 9, afterBoth, ret)).toEqual([]);
  });

  it("the DEFAULT slot never lands on a closed session", () => {
    // nextBookableSlot is what the form pre-fills. If it ignored the cut-off it
    // would pre-fill a slot the dial then renders as disabled — and the
    // requestor would submit it untouched.
    const afterBoth = at(14, 0);
    const slot = nextBookableSlot(afterBoth, 60);
    expect(slot.dayOffset).toBeGreaterThan(0); // pushed off today entirely
    // A return, same instant, may still be booked today.
    expect(nextBookableSlot(afterBoth, 60, { isReturn: true }).dayOffset).toBe(0);
  });

  it("clamping moves a now-illegal slot forward instead of leaving it to fail", () => {
    // The requestor had this afternoon selected as a RETURN, then switched the
    // booking to a delivery at 14:00.
    const afterBoth = at(14, 0);
    const held = { dayOffset: 0, hour: 15, minute: 0 };
    expect(clampSlotToDay(held, afterBoth, { isReturn: true })).toEqual(held);
    expect(clampSlotToDay(held, afterBoth).dayOffset).toBeGreaterThan(0);
  });

  it("MIRROR PIN — these values live twice, and must not drift", () => {
    // The authority is api/src/lib/bookingCutoff.ts. There is no shared module
    // across the two packages, so the mirror is pinned by naming both sides
    // here: a change on the server has to walk past this test.
    expect(MORNING_CUTOFF_MIN).toBe(8 * 60 + 30);
    expect(AFTERNOON_CUTOFF_MIN).toBe(13 * 60 + 30);
    expect(SESSION_SPLIT_MIN).toBe(12 * 60);
  });
});

/**
 * THE ADMIN OVERRIDE, CLIENT SIDE (owner ruling, 12 Aug 2026).
 *
 * The rule binds the REQUESTOR. The office can step outside it — so the picker
 * must OFFER an admin the closed slot, and the form must then collect the
 * reason the server will demand. Hiding it would remove roughly ten hours of
 * same-day capacity a day, on a system whose own Sheet1 carries urgent
 * same-day work.
 *
 * ⚠ OFFERED IS NOT EXEMPT. `isAdmin` opens the picker; the server still refuses
 * without a stated reason, and that reason is audited.
 */
describe("B7 — an admin is offered the closed slot, and told a reason is needed", () => {
  const afterBoth = at(14, 0);

  it("offers today's afternoon to an ADMIN when a requestor is refused it", () => {
    expect(bookableMinutes(TODAY, 15, afterBoth)).toEqual([]);
    expect(bookableMinutes(TODAY, 15, afterBoth, { isAdmin: true }).length).toBeGreaterThan(0);
    expect(isDayBookable(TODAY, afterBoth, { isAdmin: true })).toBe(true);
  });

  it("still hides what the CLOCK has taken, admin or not — the past is not overridable", () => {
    // B7 is a policy an admin may step outside. A pickup at 09:00 when it is
    // 14:00 is not a policy, it is gone.
    expect(bookableMinutes(TODAY, 9, afterBoth, { isAdmin: true })).toEqual([]);
  });

  it("flags exactly the slots that need a reason, and no others", () => {
    // This predicate is what the form asks, so the reason box and the server's
    // demand cannot disagree.
    expect(slotNeedsCutoffOverride({ dayOffset: 0, hour: 15, minute: 0 }, afterBoth)).toBe(true);
    // A return: exempt outright, no reason needed.
    expect(
      slotNeedsCutoffOverride({ dayOffset: 0, hour: 15, minute: 0 }, afterBoth, { isReturn: true })
    ).toBe(false);
    // Tomorrow: never gated.
    expect(slotNeedsCutoffOverride({ dayOffset: 1, hour: 15, minute: 0 }, afterBoth)).toBe(false);
    // Before the cut-off: nothing to override.
    expect(slotNeedsCutoffOverride({ dayOffset: 0, hour: 15, minute: 0 }, at(13, 29))).toBe(false);
  });
});

/**
 * ⚠ THE CUT-OFF IS A MALAYSIA RULE, AND THIS IS THE CASE THAT PROVES IT.
 *
 * B7 shipped judging the cut-off on the DEVICE clock. CI runners are UTC, so at
 * 05:36 UTC the picker read "05:36, before 08:30, the morning is open", offered
 * a today slot, and the server refused it as 13:36 MYT — four e2e booking specs
 * red, on a 10.5-hour band every day, on MAIN.
 *
 * ⚠ Every other case in this file uses LOCAL wall-clock fixtures, and the
 * developer machine is UTC+8 — so local and MYT are the same number and all 40
 * of them passed identically before and after the fix. They could not have
 * caught it. These take INSTANTS, so they are timezone-independent and fail on
 * any runner if the MYT conversion is lost.
 */
describe("cutoffClosedAt — judged in MYT, not on the device clock", () => {
  const at = (iso: string) => new Date(iso);

  it("the exact CI failure: 05:36 UTC is 13:36 MYT, so today's afternoon is SHUT", () => {
    const now = at("2026-08-12T05:36:00Z"); // 13:36 MYT
    const slot = at("2026-08-12T07:00:00Z"); // 15:00 MYT, same MYT day
    expect(cutoffClosedAt(slot, now)).toBe(true);
  });

  it("…and the morning is shut too, though the device clock reads 05:36", () => {
    const now = at("2026-08-12T05:36:00Z"); // 13:36 MYT — past BOTH cut-offs
    const slot = at("2026-08-12T03:00:00Z"); // 11:00 MYT, a morning pickup
    expect(cutoffClosedAt(slot, now)).toBe(true);
  });

  it("is OPEN at 00:20 UTC — 08:20 MYT, ten minutes before the morning closes", () => {
    const now = at("2026-08-12T00:20:00Z"); // 08:20 MYT
    expect(cutoffClosedAt(at("2026-08-12T03:00:00Z"), now)).toBe(false); // 11:00 MYT
  });

  it("gates only the MYT day the server calls today", () => {
    const now = at("2026-08-12T05:36:00Z"); // 13:36 MYT, 12 Aug
    // 16:10 UTC is 00:10 MYT on the 13th — a different MYT day, so not gated,
    // even though it is still the 12th on a UTC device.
    expect(cutoffClosedAt(at("2026-08-12T16:10:00Z"), now)).toBe(false);
  });

  it("returns and admins are never closed out", () => {
    const now = at("2026-08-12T05:36:00Z");
    const slot = at("2026-08-12T07:00:00Z");
    expect(cutoffClosedAt(slot, now, true, false)).toBe(false); // return: exempt
    expect(cutoffClosedAt(slot, now, false, true)).toBe(false); // admin: may override
  });
});
