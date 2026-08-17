/**
 * "WHICH DAY IS IT" — IN MALAYSIA TIME, NOT ON THE DEVICE'S CLOCK.
 *
 * Every "today" the SERVER computes is MYT: the dashboard's `trips_today` and
 * `completed_today` come from `getTripDayStart/End`, which bin in MYT
 * explicitly. Two client screens computed their own "today" from the device
 * clock instead (`toDateString()`, and a local Y/M/D compare), so the app and
 * the server agreed only as long as the device happened to be on MYT.
 *
 * They do not always agree:
 *   · the WEB build runs on whatever the laptop is set to — a UTC machine is
 *     8 hours behind, so between 00:00 and 08:00 MYT it is still "yesterday";
 *   · a phone with the wrong timezone, or auto-timezone off after travel;
 *   · CI, which runs UTC — the reason the vitest config pins TZ at all.
 *
 * The consequence is not cosmetic: the driver's Home decides "no trips assigned
 * today" from this, so a wrong day tells a working driver he has nothing on.
 *
 * `lib/trip.ts` already reached this conclusion for the pay ESTIMATE ("reading
 * the device's local clock would mis-rate trips on a phone whose timezone isn't
 * Malaysia"). This is the same rule for the workload display.
 *
 * ⚠ THIS IS NOT THE SHIFT DAY, AND MUST NOT BECOME IT.
 *
 * A pickup at 00:55 belongs to the previous evening's SHIFT — the operating
 * window runs 07:00 → 02:00 and wraps midnight — but it belongs to the next
 * CALENDAR day, and that is what this returns. The distinction is real and
 * currently unimplemented anywhere in the codebase (see the note on
 * `getTripDayStart`, whose shift-day branch is inert while DAILY_RESET_HOUR is
 * 0). It is deliberately NOT built here.
 *
 * When it is built, it must be named for what it is — `shiftDay` or
 * `workloadDay`, never `tripDay` — and it must stay DISPLAY-ONLY. The reason,
 * written down so the name alone does not have to carry it: the INCENTIVE day
 * is midnight MYT because Mr. Teh said so (Q1, 3 Jul 2026 — "after 12am points
 * refresh for next day"), and it decides pay. A helper that looks reusable is
 * how a 07:00 boundary would find its way into the money, silently, and the
 * driver's payslip would then disagree with his own screen about which day he
 * worked.
 */
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The MYT calendar day of an instant, as "YYYY-MM-DD" — the server's key format. */
export function mytDayKey(date: Date): string {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${myt.getUTCFullYear()}-${pad(myt.getUTCMonth() + 1)}-${pad(myt.getUTCDate())}`;
}

/** Do two instants fall on the same MYT calendar day? */
export function sameMytDay(a: Date, b: Date): boolean {
  return mytDayKey(a) === mytDayKey(b);
}
