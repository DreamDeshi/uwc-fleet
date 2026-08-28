import { mytDateKey } from "../services/incentiveEngine";
import { minutesFromEnv } from "./envNumbers";
import { mytDayStart } from "./myt";

/**
 * B7 — THE BOOKING CUT-OFFS. 10:00 for a morning pickup, 15:00 for an afternoon
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
 * ⚠ BOTH NUMBERS MOVED, 27 Aug 2026, AND ONE WAS NEVER ACTUALLY BUILT UNTIL
 * NOW. Teh hit the original 13:30 cut-off live in production at 13:43
 * (WhatsApp, same day) — "until now we still have booking lol" — and asked to
 * change it to 15:00 on the spot ("can we change to 3pm?" / "yes"). While that
 * fix was mid-deploy (2:18pm, "doing it right now, 5mins"), he sent the FULL
 * spec at 2:19pm:
 *
 *   "like this, for 'customer delivery' 3pm pickup cut off, morning session
 *    '10am', then 'interplant' no cut off time.."
 *
 * The reply at 2:20pm ("The update is live, it should be 3pm now") answered
 * only the afternoon change already in flight and echoed the 2:19pm message
 * back with a bare "Okay" — acknowledging receipt, not confirming it was
 * built. It WASN'T: the morning number stayed 08:30 and interplant stayed
 * ungated for six days, found only when the owner re-read this conversation
 * in full on 28 Aug. Same shape as this file's own "admin-editable setting…
 * agreed but not yet built" note used to be — a ruling stated in writing,
 * never implemented, silently live-wrong. Both are now correct: 10:00 for the
 * morning session, and interplant (either direction — see `isInterplant`
 * below) exempt entirely, same as a return leg already was.
 *
 * Also agreed the same conversation: a proper admin-editable setting for both
 * times, so the next change doesn't need a deploy. BUILT — see
 * `lib/settingsRegistry.ts` (keys `booking.morning_cutoff_min` /
 * `booking.afternoon_cutoff_min`) and `lib/bookingCutoffSettings.ts`. The
 * constants below are now the DEFAULTS an admin's setting overrides, not the
 * only source of truth — but they still ARE the source of truth for anyone
 * who has never touched the setting, which is why they stay literal numbers
 * here rather than becoming `minutesFromEnv` calls (see the note on the
 * constants themselves, and the guard in bookingCutoff.test.ts that checks
 * for exactly that).
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 *   booked before 10:00 MYT  → today's MORNING pickup is selectable
 *   booked before 15:00 MYT  → today's AFTERNOON pickup is selectable
 *   booked after 15:00 MYT   → the earliest selectable pickup is the next
 *                              working day
 *   a RETURN booking         → exempt; any time before midnight
 *   INTERPLANT, either way   → exempt entirely, same as a return
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
 * HIS NUMBERS — hardcoded on purpose, and NOT wrapped in `minutesFromEnv`: an
 * operator quietly moving a cut-off via a Railway env var (no review, no
 * record of who or why) would be changing what the client asked for with less
 * ceremony than a commit. These two literals are the DEFAULTS.
 *
 * ⚠ That is a different thing from an ADMIN changing it through the app. Teh
 * asked for exactly that (WhatsApp, 27 Aug 2026 — see the note above), and it
 * is now built as a `Setting` row, resolved by `bookingCutoffSettings.ts` and
 * threaded into `bookingCutoffVerdict` below as an explicit parameter — never
 * by this file reaching into the DB itself. Every change is audited (who,
 * when, old→new) in `routes/settings.ts`, which is more traceable than a
 * commit would have been, not less — the thing this comment always objected
 * to was an UNTRACKED env-var change, not a tracked admin one.
 */
export const MORNING_CUTOFF_MIN = 10 * 60; // 10:00 — the default (was 08:30 until 28 Aug 2026)
export const AFTERNOON_CUTOFF_MIN = 15 * 60; // 15:00 — the default (was 13:30 until 27 Aug 2026)

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

/** `sessionSplitMin` defaults to the module constant so every existing call
 *  that omits it keeps today's exact behaviour — same discipline as
 *  `morningCutoffMin`/`afternoonCutoffMin` on `bookingCutoffVerdict` below. */
export function sessionOf(pickup: Date, sessionSplitMin: number = SESSION_SPLIT_MIN): BookingSession {
  return mytMinutes(pickup) < sessionSplitMin ? "morning" : "afternoon";
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
      /** The cut-off minute actually applied (default OR an admin's setting) —
       *  `cutoffMessage`/`cutoffOverrideNote` format FROM this, never from a
       *  string keyed on `session` alone, so the message stays correct once
       *  the time is admin-editable and no longer always 8:30/15:00. */
      cutoffMin: number;
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
  /** Interplant work, either direction — exempt entirely (Mr. Teh, WhatsApp,
   *  27 Aug 2026 2:19pm: "then interplant no cut off time.."). Interplant
   *  RETURN was already covered by `isReturn` above; this is what actually
   *  adds coverage — interplant DELIVERY. Required, not optional, same
   *  discipline as `isReturn`: a caller must decide, never silently default
   *  to "not exempt" for a route type it forgot to check. */
  isInterplant: boolean;
  holidays: ReadonlySet<string>;
  /** Effective cut-offs, resolved by the CALLER (see bookingCutoffSettings.ts)
   *  — this function stays pure and knows nothing of settings or the DB.
   *  Default to the constants above so every existing call/test that omits
   *  these keeps today's exact behaviour. */
  morningCutoffMin?: number;
  afternoonCutoffMin?: number;
  /** The morning/afternoon boundary — OURS, not his (see SESSION_SPLIT_MIN).
   *  Same default-to-the-constant discipline as the two cut-offs above. */
  sessionSplitMin?: number;
}): CutoffVerdict {
  if (params.isReturn || params.isInterplant) return { allowed: true };

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

  const session = sessionOf(params.pickup, params.sessionSplitMin ?? SESSION_SPLIT_MIN);
  const morningCutoff = params.morningCutoffMin ?? MORNING_CUTOFF_MIN;
  const afternoonCutoff = params.afternoonCutoffMin ?? AFTERNOON_CUTOFF_MIN;
  const cutoff = session === "morning" ? morningCutoff : afternoonCutoff;
  if (mytMinutes(params.now) < cutoff) return { allowed: true };

  return {
    allowed: false,
    session,
    earliest: nextWorkingDay(todayKey, params.holidays),
    cutoffMin: cutoff,
  };
}

/** "510" → "8:30am", "900" → "3:00pm", "0" → "12:00am", "720" → "12:00pm". */
function formatClockMinutes(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const period = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/** The message the requestor sees — states the cut-off AND the way forward. */
export function cutoffMessage(verdict: Extract<CutoffVerdict, { allowed: false }>): string {
  const at = formatClockMinutes(verdict.cutoffMin);
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
  const at = formatClockMinutes(verdict.cutoffMin);
  return `Admin override: booked past the ${at} ${verdict.session} cut-off — ${reason.trim()}`;
}
