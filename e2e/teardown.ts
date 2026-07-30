/**
 * Global teardown: put the backend's dispatch mode back to whatever it was
 * BEFORE the run (captured by setup.ts).
 *
 * Every spec's resetState() switches dispatch to manual so seeded trips stay
 * pending, and nothing used to switch it back — a prod run (E2E_ALLOW_PROD=1)
 * left the LIVE TRIAL in manual on 2026-07-26, silently stranding new
 * bookings as pending. Restoring the CAPTURED value (not a hard-coded one)
 * also protects the opposite case: if the owner deliberately operates in
 * manual, a test run must not flip the trial to auto. Best-effort — an
 * unreachable API or a missing capture must not turn a green run red, but it
 * is warned loudly so the mode gets checked by hand.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADMIN } from "./helpers/accounts";
import { login, setDispatchMode, setTruckWindow } from "./helpers/api";

export const DISPATCH_MODE_STATE_FILE = join(
  __dirname,
  "test-results",
  ".dispatch-mode-before-run.json"
);

export const TRUCK_WINDOW_STATE_FILE = join(
  __dirname,
  "test-results",
  ".truck-window-before-run.json"
);

/**
 * Put the fixture truck's operating window back. setup.ts widens it to 24h so
 * the suite is not hostage to the wall clock (see the note there); leaving a
 * truck permanently 24h would quietly disable a real dispatch guard.
 */
async function restoreTruckWindow(): Promise<void> {
  if (!existsSync(TRUCK_WINDOW_STATE_FILE)) return;
  try {
    const { plate, start, end } = JSON.parse(readFileSync(TRUCK_WINDOW_STATE_FILE, "utf8")) as {
      plate: string;
      start: string;
      end: string;
    };
    const { accessToken } = await login(ADMIN);
    await setTruckWindow(accessToken, plate, { start, end });
    rmSync(TRUCK_WINDOW_STATE_FILE, { force: true });
    // eslint-disable-next-line no-console
    console.log(`teardown: ${plate} operating window restored to ${start}-${end}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `teardown: could not restore the truck window (${(err as Error).message}) — restore it manually.`
    );
  }
}

export default async function globalTeardown(): Promise<void> {
  await restoreTruckWindow();
  if (!existsSync(DISPATCH_MODE_STATE_FILE)) {
    // eslint-disable-next-line no-console
    console.warn(
      "teardown: no captured dispatch_mode (setup failed?) — check the backend's mode manually."
    );
    return;
  }
  try {
    const { dispatch_mode } = JSON.parse(readFileSync(DISPATCH_MODE_STATE_FILE, "utf8")) as {
      dispatch_mode: "auto" | "manual";
    };
    const { accessToken } = await login(ADMIN);
    await setDispatchMode(accessToken, dispatch_mode);
    rmSync(DISPATCH_MODE_STATE_FILE, { force: true });
    // eslint-disable-next-line no-console
    console.log(`teardown: dispatch_mode restored to ${dispatch_mode}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `teardown: could not restore dispatch_mode (${(err as Error).message}) — restore it manually.`
    );
  }
}
