/**
 * Global setup: record the backend's CURRENT dispatch mode so teardown can
 * restore exactly that — no assumption about what the resting state "should"
 * be. (resetState() flips to manual per spec; a prod run once left the live
 * trial that way. Hard-coding "auto" in teardown would make the opposite
 * mistake if the owner ever deliberately runs the trial in manual.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ADMIN, DRIVER, REQUESTOR } from "./helpers/accounts";
import { driverIdentity, getDispatchMode, getTruckWindow, login, setLanguage, setTruckWindow } from "./helpers/api";
import { DISPATCH_MODE_STATE_FILE, TRUCK_WINDOW_STATE_FILE } from "./teardown";
import { FIXED_PICKUP_MYT_MINUTES } from "./helpers/seed";

/**
 * Put every shared account back into English before the run starts.
 *
 * language_pref is SERVER state on accounts every spec shares, and the whole
 * suite locates by English copy. The i18n sweep restores it in an afterAll,
 * but cleanup that only runs at the END cannot help a run that was killed,
 * timed out, or failed before reaching it — and exactly that happened: one
 * aborted run left the accounts in Chinese, and the NEXT run's driver specs
 * failed against a UI whose English labels no longer existed. Normalising at
 * startup makes the suite self-healing instead of dependent on the previous
 * run having exited cleanly.
 */
async function normaliseLanguages(): Promise<void> {
  for (const account of [ADMIN, DRIVER, REQUESTOR]) {
    try {
      const { accessToken } = await login(account);
      await setLanguage(accessToken, "en");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`setup: could not reset language for ${account.phone} (${(err as Error).message})`);
    }
  }
}

/**
 * Widen the fixture truck's operating window to 24h for the run, capturing the
 * real one so teardown can put it back.
 *
 * WHY THIS AND NOT A FAKE CLOCK. Assignment rejects a pickup outside the
 * truck's window with a hard 409 OPERATING_WINDOW, and the seeded window is
 * 07:00-02:00 MYT — which wraps midnight, so the dead zone is 02:00-07:00 MYT,
 * i.e. 18:00-23:00 UTC. CI runners are UTC, so about a fifth of the day a
 * today-scheduled seed would 409 and the run would look broken.
 *
 * Freezing the clock instead would have been worse, not easier. The server
 * derives the window, the rate tier, the daily ledger reset and every arrival
 * timestamp from ITS clock, while the driver Home decides "today" from the
 * BROWSER's. Freezing one invents a skew production never has; freezing both
 * makes every stored timestamp synthetic and hides the very defects — off-peak
 * boundary, midnight reset — the suite exists to catch, because CI would always
 * sit at the same safe hour.
 *
 * A truck that operates around the clock is DATA, not a lie about time: the
 * same production code path runs, the same 409 logic, against a configuration
 * the admin UI already supports. The window RULE keeps its own coverage in
 * operatingWindow.spec.ts, which narrows a truck deliberately and asserts the
 * 409 — cover the rule had none of before.
 */
/**
 * A window that is open all day AND leaves every pickup a long runway to its
 * estimated completion.
 *
 * Getting here took THREE wrong answers, all caught by measuring:
 *
 *   00:00-23:59 — covers every minute (isWithinWindow says so), but the window
 *     also bounds the estimated COMPLETION against an ABSOLUTE end instant. A
 *     run picked up late in the MYT day finishes after 23:59 and is refused.
 *     CI: "Est. completion 01:05 is past the 23:59 operating window."
 *   00:01-00:00 — wraps, so it covers every minute too, but the end instant is
 *     still the next 00:00. A 23:00 pickup gets one hour of slack.
 *   start = now - 1h — the previous fix, and the reason this comment is longer.
 *     It reasoned only about pickups booked relative to NOW ("the seed books
 *     five minutes back"), and the suite's commonest fixture is not one:
 *     inWindowPickupIso books TOMORROW 09:00, a FIXED time of day. Once the
 *     run started after 10:00 MYT, that 09:00 fell BEFORE the window start, so
 *     windowEndInstant did not roll it forward and closed the operating day at
 *     ~09:00 on the pickup's own date — before the run had even begun.
 *
 *     That failed CI for a 3-hour band EVERY DAY (10:01-13:05 MYT =
 *     02:01-05:05 UTC), and it looked like whatever PR happened to run in it.
 *     `main` failed at 02:07 UTC with a tree that had passed at 01:56.
 *
 * ── WHAT IS ACTUALLY REQUIRED ──────────────────────────────────────────────
 *
 * windowEndInstant (api/src/services/operatingWindow.ts) resolves the end for a
 * WRAPPING window to the pickup's own day when the pickup's time-of-day is
 * before the start, and to the NEXT day when it is at or after it. So the slack
 * a pickup gets is a function of its time-of-day AND the window — and no single
 * fixed window is right for every hour, which is what the first three attempts
 * each rediscovered.
 *
 * So stop guessing one: SEARCH. Score every wrapping window against every
 * pickup this suite actually books and keep the one whose WORST case is best.
 * Over all 1440 possible start minutes this leaves at least 9 hours of slack,
 * against ~2 hours needed — and it is checked below rather than assumed.
 */

/** Minutes a one-stop run needs between pickup and estimated completion. The
 *  engine quoted 11:05 for an 09:00 pickup; doubled, because being wrong here
 *  is a red suite and the cost of extra margin is nothing. */
const RUN_SLACK_MIN = 250;

/** Every pickup time-of-day the suite books, in MYT minutes. */
function suitePickupMinutes(now: Date): number[] {
  const nowMyt = Math.floor((now.getTime() + 8 * 60 * 60 * 1000) / 60000) % 1440;
  // todayPickupIso books five minutes back — which is the PREVIOUS day's
  // time-of-day for the first five minutes after MYT midnight.
  return [...FIXED_PICKUP_MYT_MINUTES, (nowMyt - 5 + 1440) % 1440];
}

/** Slack, in minutes, that `window` leaves a pickup at `tod` (MYT minutes). */
function slackFor(tod: number, start: number, end: number): number {
  // Mirrors windowEndInstant's wrapping branch: roll to the next day iff the
  // pickup is at or after the start.
  return tod >= start ? 1440 - tod + end : end - tod;
}

function alwaysOpenWindow(now: Date): { start: string; end: string; worstSlack: number } {
  const tods = suitePickupMinutes(now);
  let best = { start: 1, end: 0, worstSlack: -Infinity };
  // end = start - 1 keeps the window WRAPPING, which is what makes it all-day.
  for (let start = 1; start < 1440; start++) {
    const end = start - 1;
    const worstSlack = Math.min(...tods.map((tod) => slackFor(tod, start, end)));
    if (worstSlack > best.worstSlack) best = { start, end, worstSlack };
  }
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { start: hhmm(best.start), end: hhmm(best.end), worstSlack: best.worstSlack };
}

async function widenFixtureTruckWindow(): Promise<void> {
  // OUTSIDE the try, and FATAL. The catch below deliberately downgrades network
  // failures to a warning, and a bad window is not a network failure — it is a
  // suite that is guaranteed to go red four minutes from now, on a spec that
  // has nothing to do with it. That is exactly how the last one was mistaken
  // for a PR's fault. Fail here, where the message names the cause.
  const open = alwaysOpenWindow(new Date());
  if (open.worstSlack < RUN_SLACK_MIN) {
    throw new Error(
      `setup: the best available truck window (${open.start}-${open.end}) leaves only ` +
        `${open.worstSlack} min of completion slack, under the ${RUN_SLACK_MIN} min a run needs. ` +
        "A fixture's pickup hour has probably moved — see FIXED_PICKUP_MYT_MINUTES in helpers/seed.ts."
    );
  }
  try {
    const { accessToken } = await login(ADMIN);
    const { plate } = await driverIdentity(DRIVER);
    const before = await getTruckWindow(accessToken, plate);
    mkdirSync(dirname(TRUCK_WINDOW_STATE_FILE), { recursive: true });
    writeFileSync(TRUCK_WINDOW_STATE_FILE, JSON.stringify({ plate, ...before }));
    await setTruckWindow(accessToken, plate, { start: open.start, end: open.end });
    // eslint-disable-next-line no-console
    console.log(
      `setup: ${plate} window ${before.start}-${before.end} -> ${open.start}-${open.end} ` +
        `(always open, worst-case slack ${open.worstSlack} min) for this run`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `setup: could not widen the truck window (${(err as Error).message}) — ` +
        "today-scheduled specs may 409 between 02:00 and 07:00 MYT."
    );
  }
}

export default async function globalSetup(): Promise<void> {
  await normaliseLanguages();
  await widenFixtureTruckWindow();
  try {
    const { accessToken } = await login(ADMIN);
    const { dispatch_mode } = await getDispatchMode(accessToken);
    mkdirSync(dirname(DISPATCH_MODE_STATE_FILE), { recursive: true });
    writeFileSync(DISPATCH_MODE_STATE_FILE, JSON.stringify({ dispatch_mode }));
    // eslint-disable-next-line no-console
    console.log(`setup: dispatch_mode=${dispatch_mode} captured for restore`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `setup: could not capture dispatch_mode (${(err as Error).message}) — teardown will skip the restore.`
    );
  }
}
