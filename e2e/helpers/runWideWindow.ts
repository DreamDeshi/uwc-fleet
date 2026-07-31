/**
 * THE ONE PLACE THE RUN-WIDE FIXTURE TRUCK WINDOW IS CHOSEN.
 *
 * It lives here rather than in setup.ts because it was in setup.ts, and
 * operatingWindow.spec.ts kept a SECOND COPY to restore the window after
 * narrowing it — a copy whose own comment said "Mirrors setup.ts's
 * alwaysOpenWindow". Fixing the original left the duplicate reinstating the bug
 * mid-run: the suite is serial (workers: 1), so from that spec onward every
 * assignment ran against the bad window and specs with nothing to do with
 * operating hours went red.
 *
 * ── WHAT THIS HAS TO GET RIGHT ─────────────────────────────────────────────
 *
 * Assignment rejects a pickup outside the truck's window with a hard 409, and
 * ALSO rejects one whose estimated COMPLETION lands past the window's end.
 * windowEndInstant (api/src/services/operatingWindow.ts) resolves that end, for
 * a WRAPPING window, to the pickup's own day when the pickup's time-of-day is
 * before the start, and to the NEXT day when it is at or after it.
 *
 * So the slack a pickup gets depends on BOTH its time-of-day and the window,
 * and no single fixed window is right at every hour. Three attempts each
 * shipped green and each was wrong at some other hour:
 *
 *   00:00-23:59 — covers every minute, but the end is ABSOLUTE. A late pickup
 *     finishes after 23:59. CI: "Est. completion 01:05 is past the 23:59
 *     operating window."
 *   00:01-00:00 — wraps, so it covers every minute, but the end instant is
 *     still the next 00:00. A 23:00 pickup gets one hour of slack.
 *   start = now - 1h — reasoned only about pickups booked relative to NOW ("the
 *     seed books five minutes back"). The suite's commonest fixture is not one:
 *     inWindowPickupIso books TOMORROW 09:00, a FIXED time of day. Once a run
 *     began after 10:00 MYT that 09:00 fell BEFORE the start, the operating day
 *     closed at ~09:00 on the pickup's own date, and everything 409'd.
 *
 *     185 failing minutes a DAY — 10:01-13:05 MYT = 02:01-05:05 UTC — and it
 *     read as whichever PR was unlucky enough to run in the band. `main` failed
 *     at 02:07 UTC with a tree that had passed at 01:56.
 *
 * So stop guessing: SEARCH. Score every wrapping window against every pickup
 * the suite actually books and keep the one whose worst case is best. That
 * leaves at least 9 hours of slack against the ~2 a run needs, at every minute
 * of the day — checked by e2e/scripts/check-window.mjs, which walks all 1440
 * start minutes against the real rule.
 */
import { FIXED_PICKUP_MYT_MINUTES } from "./seed";

/** Minutes a one-stop run needs between pickup and estimated completion. The
 *  engine quoted 11:05 for an 09:00 pickup; doubled, because being wrong here
 *  is a red suite and the cost of extra margin is nothing. */
export const RUN_SLACK_MIN = 250;

/** Every pickup time-of-day the suite books, in MYT minutes. */
export function suitePickupMinutes(now: Date): number[] {
  const nowMyt = Math.floor((now.getTime() + 8 * 60 * 60 * 1000) / 60000) % 1440;
  // todayPickupIso books five minutes back — which is the PREVIOUS day's
  // time-of-day for the first five minutes after MYT midnight.
  return [...FIXED_PICKUP_MYT_MINUTES, (nowMyt - 5 + 1440) % 1440];
}

/** Slack, in minutes, a window leaves a pickup at `tod` (MYT minutes). Mirrors
 *  windowEndInstant's wrapping branch: roll to the next day iff the pickup is
 *  at or after the start. */
export function slackFor(tod: number, start: number, end: number): number {
  return tod >= start ? 1440 - tod + end : end - tod;
}

export interface RunWideWindow {
  start: string;
  end: string;
  worstSlack: number;
}

export function runWideWindow(now: Date = new Date()): RunWideWindow {
  const tods = suitePickupMinutes(now);
  let best = { start: 1, end: 0, worstSlack: -Infinity };
  // end = start - 1 keeps the window WRAPPING, which is what makes it all-day.
  for (let start = 1; start < 1440; start++) {
    const end = start - 1;
    const worstSlack = Math.min(...tods.map((tod) => slackFor(tod, start, end)));
    if (worstSlack > best.worstSlack) best = { start, end, worstSlack };
  }
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { start: hhmm(best.start), end: hhmm(best.end), worstSlack: best.worstSlack };
}
