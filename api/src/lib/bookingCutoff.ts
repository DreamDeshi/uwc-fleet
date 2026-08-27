import { mytDateKey } from "../services/incentiveEngine";
import { minutesFromEnv } from "./envNumbers";
import { mytDayStart } from "./myt";

/**
 * B7 — THE BOOKING CUT-OFFS. 08:30 for a morning pickup, 15:00 for an afternoon
 * one; after that the earliest selectable day is the next WORKING day.
 *
 * ── SOURCE, AND WHAT IS HIS AND WHAT IS OURS ─────────────────────────────────
 *
 * Mr. Teh, R5 B7 (11 Aug 2026), verbatim:
 *
 *   "the auto assign I think you can arrange first come first serve basis, then
 *    cut of time for morning delivery 830am, afternoon 130pm…if booking after
 *    cut off time, they have to choose next working day, for return cargo from
 *    supplier / customer, they can choose pickup anytime before 12am"
 *
 * ⚠ THE MODEL OF THAT SENTENCE IS THE OWNER'S READING (12 Aug 2026), NOT THE
 * CLIENT'S INSTRUCTION. He scopes the cut-offs to "morning DELIVERY" and
 * "afternoon DELIVERY", and `Trip` has only `pickup_datetime` — there is no
 * delivery session, slot or deliver-by field anywhere in the model, and
 * `schema.prisma` is frozen. The owner ruled that his own next clause settles
 * it: "if booking after cut off time, THEY HAVE TO CHOOSE next working day"
 * describes what a requestor may SELECT, so the cut-off gates WHEN A BOOKING MAY
 * BE PLACED INTO A SLOT rather than a property the trip carries. That is why
 * this compares the REQUEST INSTANT with the REQUESTED PICKUP and stores
 * nothing: `created_at` and `pickup_datetime` already exist.
 *
 * If Mr. Teh ever describes a delivery session directly, this reading is the
 * thing to revisit — not the cut-off times, which are his.
 *
 * ⚠ THE AFTERNOON NUMBER MOVED, 27 Aug 2026. Teh hit the original 13:30
 * cut-off live in production at 13:43 (WhatsApp, same day) — "until now we
 * still have booking lol" — and asked to change it to 15:00 on the spot
 * ("can we change to 3pm?" / "yes"). This is the same authority as the
 * original number (his own written word, this time in chat rather than the
 * R5 doc), so it is still HIS number, just a later one. The morning cut-off
 * (08:30) is untouched — he asked about the afternoon only.
 *
 * Also agreed the same conversation: a proper admin-editable setting for both
 * times, so the next change doesn't need a deploy. NOT YET BUILT — that is
 * still a schema change (`AppSetting` has no free-form settings column) and
 * ships separately. Until then this constant is still the one source of truth,
 * and moving it again means editing this file, same as before.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 *   booked before 08:30 MYT  → today's MORNING pickup is selectable
 *   booked before 15:00 MYT  → today's AFTERNOON pickup is selectable
 *   booked after 15:00 MYT   → the earliest selectable pickup is the next
 *                              working day
 *   a RETURN booking         → exempt; any time before midnight
 *
 * Booking for a FUTURE day is never restricted — the cut-offs are about today's
 * dispatch, and a requestor booking Thursday on Tuesday costs dispatch nothing.
 *
 * ⚠ MORNING vs AFTERNOON is split at 12:00 MYT, and that split is OURS. He gave
 * two sessions and two cut-offs but never named the boundary; noon is the
 * ordinary meaning of the two words and the only value that makes both cut-offs
 * sit inside the session they gate. Recorded as a choice rather than a
 * discovery, and env-tunable for exactly that reason — see SESSION_SPLIT_MIN.
 */

/**
 * HIS NUMBERS — hardcoded on purpose. "830am" (11 Aug, R5) and "3pm" (27 Aug,
 * chat — superseding the original "130pm") are quoted client requirements, not
 * tunables; an operator quietly moving a cut-off would be changing what the
 * client asked for, and it should take a commit and a reader. An admin-editable
 * version of this is agreed but not yet built — see the note above.
 */
export const MORNING_CUTOFF_MIN = 8 * 60 + 30; // 08:30
export const AFTERNOON_CUTOFF_MIN = 15 * 60; // 15:00 (was 13:30 until 27 Aug 2026)

/**
 * OUR NUMBER — an INVENTED CONSTANT, and therefore env-tunable (owner ruling,
 * 12 Aug 2026; the same treatment as the other invented constants tracked in
 * OPEN_ITEMS N11 — the scheduling-conflict buffer, the operating-window
 * estimates, the exception-alert threshold).
 *
 * Mr. Teh gave two SESSIONS and two cut-offs but never said where morning ends.
 * Noon is the ordinary meaning of the two words, and the only value that puts
 * each cut-off inside the session it gates — but it is ours, not his, so it
 * carries an override rather than pretending to be a requirement. If the office
 * turns out to treat 11:00 or 14:00 as the divide, that is a variable, not a
 * release.
 *
 * Override with BOOKING_SESSION_SPLIT_MIN (minutes after MYT midnight;
 * 720 = 12:00).
 */
export const SESSION_SPLIT_MIN = minutesFromEnv("BOOKING_SESSION_SPLIT_MIN", 12 * 60);

/**
 * Minutes after MYT midnight for an instant — measured FROM `mytDayStart`, the
 * definition the daily sweep already uses, rather than from a second copy of
 * the +8 offset. One rule, one place.
 */
export function mytMinutes(d: Date): number {
  return Math.floor((d.getTime() - mytDayStart(d).getTime()) / 60_000);
}

export type BookingSession = "morning" | "afternoon";

export function sessionOf(pickup: Date): BookingSession {
  return mytMinutes(pickup) < SESSION_SPLIT_MIN ? "morning" : "afternoon";
}

/**
 * THE WORKING WEEK IS MONDAY–SATURDAY, minus UWC holidays.
 *
 * Not an invention: Mr. Teh, R1 Q5 (24 Jul 2026) — "their working day is Monday
 * to Saturday" — and A14 (29 Jul) confirms no driver is flexi-shift. Sunday is
 * the only weekly non-working day, and the holiday list is the Batu Kawan one
 * already loaded for the rate tier, NOT all Malaysian public holidays.
 *
 * `holidays` is a set of MYT "YYYY-MM-DD" keys, exactly as isOffPeak takes it,
 * so both rules read one calendar.
 */
export function isWorkingDay(dateKey: string, holidays: ReadonlySet<string>): boolean {
  if (holidays.has(dateKey)) return false;
  const [y, m, d] = dateKey.split("-").map(Number);
  // Sunday = 0. Built in UTC from the key's own parts, so the server's timezone
  // cannot shift which weekday a MYT date is.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0;
}

/** The next working day STRICTLY AFTER `dateKey`. */
export function nextWorkingDay(dateKey: string, holidays: ReadonlySet<string>): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  let cursor = Date.UTC(y, m - 1, d);
  // A bounded walk: 14 days covers any run of holidays this calendar contains
  // and refuses to spin if a future calendar is pathological.
  for (let i = 0; i < 14; i++) {
    cursor += 24 * 60 * 60 * 1000;
    const next = new Date(cursor);
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
    if (isWorkingDay(key, holidays)) return key;
  }
  return dateKey;
}

export type CutoffVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Which cut-off closed it — for the message, and for tests to be specific. */
      session: BookingSession;
      /** The earliest MYT day this booking may now select. */
      earliest: string;
    };

/**
 * May this booking be placed, given when it is being made?
 *
 * PURE — the caller supplies `now`, the holiday set and whether the booking is a
 * return leg. Nothing here reads the clock or the database, so every boundary
 * below is testable at the minute.
 */
export function bookingCutoffVerdict(params: {
  now: Date;
  pickup: Date;
  /** Return cargo from a supplier/customer — exempt, "anytime before 12am". */
  isReturn: boolean;
  holidays: ReadonlySet<string>;
}): CutoffVerdict {
  if (params.isReturn) return { allowed: true };

  // ⚠ A PICKUP ALREADY IN THE PAST IS NOT THIS RULE'S BUSINESS. The route has
  // its own PICKUP_IN_PAST, and this must not become a second, differently
  // worded rejection for the same mistake — a requestor who typed this morning
  // by accident should be told the time has gone, not lectured about a cut-off.
  //
  // Caught by an EXISTING spec (tests-integration/tripEdit.test.ts, "an
  // UNCHANGED pickup that has drifted into the past"), which had already pinned
  // PICKUP_IN_PAST as the answer for a same-day past pickup. The first version
  // of this file only exempted a pickup on an EARLIER DAY, so a pickup two
  // hours ago was still "today" and the cut-off answered first.
  if (params.pickup.getTime() <= params.now.getTime()) return { allowed: true };

  const todayKey = mytDateKey(params.now);
  const pickupKey = mytDateKey(params.pickup);
  // Only TODAY is gated: a future day is unrestricted, because the cut-offs are
  // about today's dispatch and booking ahead costs it nothing.
  if (pickupKey !== todayKey) return { allowed: true };

  const session = sessionOf(params.pickup);
  const cutoff = session === "morning" ? MORNING_CUTOFF_MIN : AFTERNOON_CUTOFF_MIN;
  if (mytMinutes(params.now) < cutoff) return { allowed: true };

  return { allowed: false, session, earliest: nextWorkingDay(todayKey, params.holidays) };
}

/** The message the requestor sees — states the cut-off AND the way forward. */
export function cutoffMessage(verdict: Extract<CutoffVerdict, { allowed: false }>): string {
  const at = verdict.session === "morning" ? "8:30am" : "3:00pm";
  const label = verdict.session === "morning" ? "Morning" : "Afternoon";
  return `${label} pickups close at ${at}. The earliest pickup you can book now is ${verdict.earliest}.`;
}

/**
 * THE ADMIN OVERRIDE — the rule binds the REQUESTOR; the office can step
 * outside it, on the record.
 *
 * Owner ruling, 12 Aug 2026. Read literally, B7 removes ALL same-day booking
 * after the afternoon cut-off (15:00 since 27 Aug 2026, was 13:30), and the
 * working day runs to midnight — roughly nine hours of capacity the office
 * could no longer use. Urgent same-day work exists: Mr.
 * Teh's own Sheet1 carries "CONQUEST (est 2 pallet P7 URGENT". The first time a
 * clerk cannot book that, they call it a broken system rather than a rule they
 * asked for.
 *
 * The shape is the most Teh-consistent one in this codebase, not an invention:
 * email pt 6 has the admin authorising cross-class lorry swaps, R3 A7 has the
 * admin deciding when the fleet is full, and A19 gives the admin edit rights at
 * every status. Throughout, the rule binds the requestor and the admin may step
 * outside it — so nobody is blocked and his rule is not softened.
 *
 * ⚠ THE REASON IS MANDATORY, which is what keeps this an override rather than
 * an exemption. An admin who books past the cut-off without one is refused;
 * with one, the booking proceeds and the note below goes on the trip's own
 * immutable timeline beside an audit row naming who did it. Same shape as
 * `incentive_override_reason`, which is required exactly when the approved
 * figure differs from the proposal.
 */
export function cutoffOverrideNote(
  verdict: Extract<CutoffVerdict, { allowed: false }>,
  reason: string
): string {
  const at = verdict.session === "morning" ? "8:30am" : "3:00pm";
  return `Admin override: booked past the ${at} ${verdict.session} cut-off — ${reason.trim()}`;
}
