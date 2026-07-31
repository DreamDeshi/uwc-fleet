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
import { RUN_SLACK_MIN, runWideWindow } from "./helpers/runWideWindow";

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
async function widenFixtureTruckWindow(): Promise<void> {
  // OUTSIDE the try, and FATAL. The catch below deliberately downgrades network
  // failures to a warning, and a bad window is not a network failure — it is a
  // suite that is guaranteed to go red four minutes from now, on a spec that
  // has nothing to do with it. That is exactly how the last one was mistaken
  // for a PR's fault. Fail here, where the message names the cause.
  const open = runWideWindow();
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
