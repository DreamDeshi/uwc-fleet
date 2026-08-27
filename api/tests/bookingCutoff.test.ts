import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  AFTERNOON_CUTOFF_MIN,
  MORNING_CUTOFF_MIN,
  SESSION_SPLIT_MIN,
  bookingCutoffVerdict,
  cutoffMessage,
  cutoffOverrideNote,
  isWorkingDay,
  mytMinutes,
  nextWorkingDay,
  sessionOf,
} from "../src/lib/bookingCutoff";
import { isInterplantRouteType, isReturnRouteType } from "../src/lib/uwcSpec";

/**
 * B7 — THE BOOKING CUT-OFFS.
 *
 * Mr. Teh (11 Aug 2026): "cut of time for morning delivery 830am, afternoon
 * 130pm…if booking after cut off time, they have to choose next working day,
 * for return cargo from supplier / customer, they can choose pickup anytime
 * before 12am".
 *
 * ⚠ The TIMES are his. The MODEL — comparing the request instant with the
 * requested pickup, rather than storing a session on the trip — is the owner's
 * reading (12 Aug 2026), taken because `Trip` has only `pickup_datetime` and no
 * delivery-session field exists. Noon as the morning/afternoon split is a
 * choice, recorded as one. Both are pinned here so a future reader can see
 * exactly which lines would move if either is revisited.
 *
 * All times below are written in UTC and annotated in MYT (+8).
 */

// Monday 10 Aug 2026 is a working day with no holiday.
const MON = (hhmmUtc: string) => new Date(`2026-08-10T${hhmmUtc}:00Z`);
const NO_HOLIDAYS = new Set<string>();

// 08:00 MYT Monday = 00:00Z. 12:00 MYT = 04:00Z. 15:00 MYT = 07:00Z.
const at = (mytHour: number, mytMin = 0) => {
  const utcMinutes = mytHour * 60 + mytMin - 8 * 60;
  const d = new Date(Date.UTC(2026, 7, 10, 0, 0, 0));
  return new Date(d.getTime() + utcMinutes * 60_000);
};

describe("mytMinutes / sessionOf — the day's shape", () => {
  it("counts minutes from MYT midnight, not from UTC midnight", () => {
    expect(mytMinutes(at(0, 0))).toBe(0);
    expect(mytMinutes(at(10, 0))).toBe(MORNING_CUTOFF_MIN);
    expect(mytMinutes(at(15, 0))).toBe(AFTERNOON_CUTOFF_MIN);
    expect(mytMinutes(at(23, 59))).toBe(23 * 60 + 59);
    // The trap this avoids: 2026-08-10T00:00Z is 08:00 MYT, not midnight.
    expect(mytMinutes(MON("00:00"))).toBe(8 * 60);
  });

  it("splits morning from afternoon at noon MYT", () => {
    expect(sessionOf(at(11, 59))).toBe("morning");
    expect(sessionOf(at(12, 0))).toBe("afternoon");
  });

  it("the split is OURS and carries an override; the cut-offs are HIS and do not", () => {
    // Owner ruling 12 Aug 2026: an invented constant is env-tunable and named
    // as ours (OPEN_ITEMS N11). "10am" and "3pm" (both moved from "830am" and
    // "130pm" on 27/28 Aug 2026 — same authority, a later chat) are quoted
    // client requirements, so moving one must take a commit and a reader, not a
    // variable — this asserts the asymmetry rather than trusting a comment.
    expect(SESSION_SPLIT_MIN).toBe(12 * 60); // the default, absent an override
    expect(MORNING_CUTOFF_MIN).toBe(10 * 60);
    expect(AFTERNOON_CUTOFF_MIN).toBe(15 * 60);
    const raw = readFileSync(join(__dirname, "..", "src", "lib", "bookingCutoff.ts"), "utf8");
    expect(raw.length).toBeGreaterThan(500); // not a vacuous read
    // ⚠ SCAN THE CODE, NOT THE COMMENTS. A source guard that reads comments is
    // wrong in BOTH directions, and this one asserts in both. The positive
    // below would be satisfied by a comment merely MENTIONING the env read —
    // the guard would pass while the code no longer did it. The two negatives
    // would go red on a comment EXPLAINING that his cut-offs must not become
    // env-tunable, i.e. the guard would punish the note that says why it
    // exists. (Latent here, not live: today's mention on line 71 is too short
    // to satisfy the positive. Found 18 Aug after the same defect turned up in
    // mobile/src/lib/mytDay.test.ts.)
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain('minutesFromEnv("BOOKING_SESSION_SPLIT_MIN"');
    // His two are literals — no env name may appear against either.
    //
    // ⚠ This guards against an UNTRACKED env-var override, which is a
    // different thing from the admin-editable setting built 27 Aug 2026 (see
    // "an admin-editable override changes which cut-off applies" below). That
    // layer lives entirely OUTSIDE this file — bookingCutoffSettings.ts
    // resolves the effective value and the caller passes it into
    // bookingCutoffVerdict as an explicit parameter — so it can exist without
    // this file ever containing `minutesFromEnv` against either constant.
    expect(src).not.toContain("MORNING_CUTOFF_MIN = minutesFromEnv");
    expect(src).not.toContain("AFTERNOON_CUTOFF_MIN = minutesFromEnv");
  });
});

describe("B7 — a MORNING pickup closes at 10:00", () => {
  // 11:00 rather than 09:00: the pickup has to stay in the FUTURE relative to
  // "now" at every boundary tested below, or the verdict short-circuits via
  // "already in the past" instead of ever reaching the cut-off check.
  const morningToday = at(11, 0); // 11:00 MYT — a morning pickup

  it("is selectable at 09:59", () => {
    expect(
      bookingCutoffVerdict({ now: at(9, 59), pickup: morningToday, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
  });

  it("is CLOSED at 10:00 exactly — the cut-off is inclusive", () => {
    // The boundary minute belongs to the closed side: "morning session 10am"
    // reads as "by 10:00", and a rule that admits 10:00:59 would be a rule
    // nobody could state.
    const v = bookingCutoffVerdict({ now: at(10, 0), pickup: morningToday, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    expect(v.allowed).toBe(false);
    expect(v).toMatchObject({ session: "morning", earliest: "2026-08-11" });
  });

  it("names the cut-off AND the way forward", () => {
    // now=10:30 rather than 09:00 (pre-28 Aug this cut-off was 08:30): the
    // pickup has to be in the FUTURE for the rule to reach the cut-off at all
    // — a past pickup belongs to PICKUP_IN_PAST.
    const v = bookingCutoffVerdict({ now: at(10, 30), pickup: at(11, 30), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(cutoffMessage(v)).toBe(
      "Morning pickups close at 10:00am. The earliest pickup you can book now is 2026-08-11."
    );
  });
});

describe("B7 — an AFTERNOON pickup closes at 15:00", () => {
  const afternoonToday = at(15, 30); // 15:30 MYT — after the (now later) cut-off instant

  it("is still selectable at 14:59, well after the morning cut-off", () => {
    // The two cut-offs are independent: missing 08:30 does not close the day.
    expect(
      bookingCutoffVerdict({ now: at(14, 59), pickup: afternoonToday, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
  });

  it("is CLOSED at 15:00", () => {
    const v = bookingCutoffVerdict({ now: at(15, 0), pickup: afternoonToday, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    expect(v.allowed).toBe(false);
    expect(v).toMatchObject({ session: "afternoon", earliest: "2026-08-11" });
  });

  it("the sessions do not pool: at 11:00 the morning is shut and the afternoon is open", () => {
    // Stated at 11:00 because that is the last hour where a FUTURE morning slot
    // still exists — after noon the morning is unreachable rather than closed,
    // which is a different thing and would make this case vacuous.
    const morning = bookingCutoffVerdict({ now: at(11, 0), pickup: at(11, 30), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    expect(morning.allowed).toBe(false);
    expect(morning).toMatchObject({ session: "morning" });

    const afternoon = bookingCutoffVerdict({ now: at(11, 0), pickup: at(15, 0), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    expect(afternoon).toEqual({ allowed: true });
  });
});

describe("B7 — an admin-editable override changes which cut-off applies", () => {
  // 27 Aug 2026: Teh agreed an admin should be able to change these times
  // without a deploy (see settingsRegistry.ts / bookingCutoffSettings.ts).
  // The function under test stays PURE and knows nothing of the DB — the
  // caller resolves the effective value and passes it in. These cases prove
  // the override actually changes the verdict, not just that the parameter
  // exists.
  it("an explicit morningCutoffMin moves the morning boundary", () => {
    const pickup = at(9, 0); // 09:00 MYT
    // At the DEFAULT 08:30, 08:15 is still open (before the default cut-off).
    expect(
      bookingCutoffVerdict({ now: at(8, 15), pickup, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
    // An admin setting of 08:00 closes that same instant.
    const v = bookingCutoffVerdict({
      now: at(8, 15),
      pickup,
      isReturn: false, isInterplant: false,
      holidays: NO_HOLIDAYS,
      morningCutoffMin: 8 * 60,
    });
    expect(v.allowed).toBe(false);
  });

  it("an explicit afternoonCutoffMin moves the afternoon boundary", () => {
    const pickup = at(15, 30);
    // At the DEFAULT 15:00, 15:00 sharp is already closed (inclusive boundary).
    expect(
      bookingCutoffVerdict({ now: at(15, 0), pickup, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS }).allowed
    ).toBe(false);
    // An admin setting of 16:00 keeps that same instant open.
    expect(
      bookingCutoffVerdict({
        now: at(15, 0),
        pickup,
        isReturn: false, isInterplant: false,
        holidays: NO_HOLIDAYS,
        afternoonCutoffMin: 16 * 60,
      })
    ).toEqual({ allowed: true });
  });

  it("omitting the override params behaves exactly as before — the default is unchanged", () => {
    const withDefaults = bookingCutoffVerdict({ now: at(15, 0), pickup: at(15, 30), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS });
    const withExplicitDefaults = bookingCutoffVerdict({
      now: at(15, 0),
      pickup: at(15, 30),
      isReturn: false, isInterplant: false,
      holidays: NO_HOLIDAYS,
      morningCutoffMin: MORNING_CUTOFF_MIN,
      afternoonCutoffMin: AFTERNOON_CUTOFF_MIN,
    });
    expect(withExplicitDefaults).toEqual(withDefaults);
  });

  // The bug this catches: cutoffMessage/cutoffOverrideNote used to derive
  // "8:30am"/"3:00pm" from `session` alone, so an admin-edited cutoff would
  // have produced a CORRECT verdict with a WRONG, stale message.
  it("cutoffMessage reports the OVERRIDDEN time, not the hardcoded default text", () => {
    const v = bookingCutoffVerdict({
      now: at(16, 0),
      pickup: at(16, 30),
      isReturn: false, isInterplant: false,
      holidays: NO_HOLIDAYS,
      afternoonCutoffMin: 16 * 60,
    });
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(cutoffMessage(v)).toBe(
      "Afternoon pickups close at 4:00pm. The earliest pickup you can book now is 2026-08-11."
    );
    expect(cutoffOverrideNote(v, "office is closing early")).toBe(
      "Admin override: booked past the 4:00pm afternoon cut-off — office is closing early"
    );
  });
});

describe("B7 — only TODAY is gated", () => {
  it("tomorrow morning is selectable at 23:00 tonight", () => {
    // The cut-offs protect today's dispatch. Booking ahead is what the client
    // wants people to do, and restricting it would be inventing a rule.
    expect(
      bookingCutoffVerdict({
        now: at(23, 0),
        pickup: new Date("2026-08-11T01:00:00Z"), // 09:00 MYT Tuesday
        isReturn: false, isInterplant: false,
        holidays: NO_HOLIDAYS,
      })
    ).toEqual({ allowed: true });
  });

  it("does not become a second rejection for a pickup already in the past", () => {
    // A past pickup is the route's own PICKUP_IN_PAST. If this returned a
    // cut-off error too, the requestor would get whichever message happened to
    // be checked first for the same mistake.
    expect(
      bookingCutoffVerdict({
        now: at(9, 0),
        pickup: new Date("2026-08-09T01:00:00Z"), // Sunday, yesterday
        isReturn: false, isInterplant: false,
        holidays: NO_HOLIDAYS,
      })
    ).toEqual({ allowed: true });
  });

  it("…including a past pickup EARLIER THE SAME DAY — the case that actually bit", () => {
    // ⚠ The first version of this rule only exempted an earlier DAY, so a
    // pickup two hours ago was still "today" and the cut-off answered before
    // PICKUP_IN_PAST could. Found by an existing spec that had already pinned
    // the right answer (tests-integration/tripEdit.test.ts). A same-day past
    // pickup at every hour past both cut-offs:
    expect(
      bookingCutoffVerdict({ now: at(15, 30), pickup: at(9, 0), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
    expect(
      bookingCutoffVerdict({ now: at(23, 0), pickup: at(15, 0), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
    // …but the same instant one minute in the FUTURE is still gated.
    expect(
      bookingCutoffVerdict({ now: at(15, 30), pickup: at(15, 31), isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS }).allowed
    ).toBe(false);
  });
});

describe("B7 — return cargo is exempt", () => {
  it("a return may be booked for this afternoon at 23:00", () => {
    expect(
      bookingCutoffVerdict({ now: at(23, 0), pickup: at(15, 0), isReturn: true, isInterplant: false, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
  });

  it("the exemption is keyed on the seeded RETURN route types", () => {
    expect(isReturnRouteType("Customer Return")).toBe(true);
    expect(isReturnRouteType("Supplier Return")).toBe(true);
    // ⚠ HIS SENTENCE NAMED TWO; this exempts the third as well — a decision,
    // not a reading. Interplant pay is per completed ROUND TRIP, so blocking a
    // return leg strands the outbound leg's point and can lose it altogether.
    expect(isReturnRouteType("Inter-Plant Return")).toBe(true);
    // Deliveries are gated.
    expect(isReturnRouteType("Customer Delivery")).toBe(false);
    expect(isReturnRouteType("Supplier Delivery")).toBe(false);
    expect(isReturnRouteType("Inter-Plant Delivery")).toBe(false);
    expect(isReturnRouteType(null)).toBe(false);
  });
});

describe("B7 — interplant is exempt entirely, either direction", () => {
  // Mr. Teh, WhatsApp, 27 Aug 2026 2:19pm: "then 'interplant' no cut off
  // time..". Interplant RETURN was already covered by the return exemption
  // above; this is what actually adds coverage — interplant DELIVERY. Both
  // shipped together, 28 Aug 2026, six days after the message that asked for
  // them (see bookingCutoff.ts's header for why).
  it("an interplant DELIVERY may be booked for this morning at 23:00 — the case return exemption never covered", () => {
    expect(
      bookingCutoffVerdict({ now: at(23, 0), pickup: at(11, 0), isReturn: false, isInterplant: true, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
  });

  it("an interplant DELIVERY may be booked for this afternoon at 23:00", () => {
    expect(
      bookingCutoffVerdict({ now: at(23, 0), pickup: at(15, 0), isReturn: false, isInterplant: true, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
  });

  it("the exemption is keyed on the seeded INTERPLANT route types, both directions", () => {
    expect(isInterplantRouteType("Inter-Plant Delivery")).toBe(true);
    expect(isInterplantRouteType("Inter-Plant Return")).toBe(true);
    // Customer/supplier work is gated either way.
    expect(isInterplantRouteType("Customer Delivery")).toBe(false);
    expect(isInterplantRouteType("Customer Return")).toBe(false);
    expect(isInterplantRouteType("Supplier Delivery")).toBe(false);
    expect(isInterplantRouteType("Supplier Return")).toBe(false);
    expect(isInterplantRouteType(null)).toBe(false);
  });

  it("the SAME instant that exempts an interplant delivery still gates a customer one — not accidentally global", () => {
    const now = at(10, 30);
    const pickup = at(11, 0); // future relative to `now`, so the cut-off is actually reached
    expect(
      bookingCutoffVerdict({ now, pickup, isReturn: false, isInterplant: true, holidays: NO_HOLIDAYS })
    ).toEqual({ allowed: true });
    expect(
      bookingCutoffVerdict({ now, pickup, isReturn: false, isInterplant: false, holidays: NO_HOLIDAYS }).allowed
    ).toBe(false);
  });
});

describe("B7 — the next WORKING day", () => {
  // R1 Q5: "their working day is Monday to Saturday"; A14 confirms no driver is
  // flexi-shift. Sunday is the only weekly non-working day, and the calendar is
  // the UWC (Batu Kawan) holiday list, not all Malaysian public holidays.
  it("Saturday IS a working day — its next is Monday, skipping Sunday", () => {
    expect(isWorkingDay("2026-08-15", NO_HOLIDAYS)).toBe(true); // Saturday
    expect(isWorkingDay("2026-08-16", NO_HOLIDAYS)).toBe(false); // Sunday
    expect(nextWorkingDay("2026-08-15", NO_HOLIDAYS)).toBe("2026-08-17"); // Monday
  });

  it("skips a UWC holiday, and a holiday that abuts a Sunday", () => {
    const holidays = new Set(["2026-08-11", "2026-08-12"]);
    expect(nextWorkingDay("2026-08-10", holidays)).toBe("2026-08-13");
    // Friday, with Saturday a holiday and Sunday non-working → Monday.
    expect(nextWorkingDay("2026-08-14", new Set(["2026-08-15"]))).toBe("2026-08-17");
  });

  it("a booking closed on Saturday afternoon points at Monday", () => {
    // 15:30 MYT Saturday 15 Aug = 07:30Z — past the (now later) afternoon cut-off.
    const v = bookingCutoffVerdict({
      now: new Date("2026-08-15T07:30:00Z"),
      pickup: new Date("2026-08-15T08:00:00Z"), // 16:00 MYT the same day
      isReturn: false, isInterplant: false,
      holidays: NO_HOLIDAYS,
    });
    expect(v.allowed).toBe(false);
    expect(v).toMatchObject({ earliest: "2026-08-17" });
  });
});
