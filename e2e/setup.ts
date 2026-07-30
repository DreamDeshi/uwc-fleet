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
import { getDispatchMode, login, setLanguage } from "./helpers/api";
import { DISPATCH_MODE_STATE_FILE } from "./teardown";

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

export default async function globalSetup(): Promise<void> {
  await normaliseLanguages();
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
