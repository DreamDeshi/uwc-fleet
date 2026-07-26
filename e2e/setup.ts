/**
 * Global setup: record the backend's CURRENT dispatch mode so teardown can
 * restore exactly that — no assumption about what the resting state "should"
 * be. (resetState() flips to manual per spec; a prod run once left the live
 * trial that way. Hard-coding "auto" in teardown would make the opposite
 * mistake if the owner ever deliberately runs the trial in manual.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ADMIN } from "./helpers/accounts";
import { getDispatchMode, login } from "./helpers/api";
import { DISPATCH_MODE_STATE_FILE } from "./teardown";

export default async function globalSetup(): Promise<void> {
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
