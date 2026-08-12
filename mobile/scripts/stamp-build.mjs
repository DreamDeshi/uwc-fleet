/**
 * Stamp the web export with the commit it was built from.
 *
 * WHY: twice on 12 Aug 2026 a manual verification nearly produced a wrong
 * conclusion because it ran against a stale `dist/` — once a build from two days
 * earlier (`serve.mjs` hardcodes `./dist` and silently ignores a directory
 * argument), once an export taken before the very fix being verified. Both times
 * the only thing that caught it was remembering to grep the bundle for an
 * expected string.
 *
 * That is not a control. It works only when someone thinks to do it, and only
 * when they happen to grep for the right string — the same weakness as a guard
 * nothing calls. So the build records what it is, and the run refuses to start
 * if that does not match HEAD.
 *
 * Writes dist/BUILD_SHA:  <sha> [dirty]
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = process.argv[2] ?? "dist";
const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(mobileDir, outDir, "BUILD_SHA");

const git = (cmd) => execSync(cmd, { cwd: mobileDir, encoding: "utf-8" }).trim();

/**
 * ⚠ A STAMP MUST NEVER BE THE THING THAT STOPS THE APP SHIPPING.
 *
 * This script exited 1 when `git rev-parse HEAD` failed, and the Railway
 * builder has no `.git` — it copies the source, not the repository. So from the
 * moment this file landed (PR #145, 12 Aug 2026 02:13) EVERY deploy of the
 * mobile web service failed, at the very last step, AFTER `expo export` had
 * already written a perfectly good bundle. The trial link — the one Mr. Teh and
 * his COO use — went on serving the 11 Aug build while `main` moved five
 * commits ahead, and Railway kept reporting the service "Online" because the
 * previous deployment was still up. A failed deploy is silent.
 *
 * ⚠ AND CI COULD NEVER HAVE CAUGHT IT. The e2e job runs
 * `npx expo export --platform web` DIRECTLY; nothing in CI runs `build:web`,
 * so the Railway builder is the only consumer of this script anywhere. Same
 * family as the stale-bundle problem this file was written to prevent: a check
 * that is only ever exercised by the one path nobody watches.
 *
 * So: git first (local dev, where it can also detect a dirty tree), then
 * whatever the deploy platform says the commit is, then `unknown` — with a
 * warning and exit 0. `unknown` fails the freshness gate in
 * e2e/handover-run.mjs by construction (it can never equal HEAD), which is the
 * right direction: the app deploys, and the verification tool still refuses to
 * trust a bundle it cannot identify.
 */
function fromGit() {
  try {
    const sha = git("git rev-parse HEAD");
    // A dirty tree means the bundle does NOT correspond to any commit, which is
    // worth knowing: it is the state in which "I rebuilt it" is least reliable.
    //
    // TRACKED changes only (-uno). Untracked build output — dist/ itself, and any
    // scratch export directory sitting beside it — is not a difference between the
    // bundle and the commit, and counting it made every stamp read "dirty",
    // which would have made the freshness gate cry wolf until someone disabled it.
    const dirty = git("git status --porcelain -uno -- .") !== "";
    return dirty ? `${sha} dirty` : sha;
  } catch {
    return null;
  }
}

/** The commit the BUILDER was given, for platforms that check out without .git. */
function fromEnv() {
  // RAILWAY_GIT_COMMIT_SHA is what deploys this repo; the other two keep the
  // script honest anywhere else it is ever run.
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || process.env.GITHUB_SHA;
  return sha && sha.trim() ? sha.trim() : null;
}

const stamp = fromGit() ?? fromEnv() ?? "unknown";
if (stamp === "unknown") {
  console.warn(
    "stamp-build: no git repository and no commit in the environment — stamping 'unknown'. " +
      "The bundle is fine; it just cannot be identified, so the freshness gate will refuse it."
  );
}

if (!fs.existsSync(path.dirname(target))) {
  console.error(`stamp-build: ${path.dirname(target)} does not exist — did the export run?`);
  process.exit(1);
}

fs.writeFileSync(target, `${stamp}\n`);
console.log(`stamp-build: ${outDir}/BUILD_SHA = ${stamp}`);
