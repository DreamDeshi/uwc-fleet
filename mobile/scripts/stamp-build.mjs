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

let stamp;
try {
  const sha = git("git rev-parse HEAD");
  // A dirty tree means the bundle does NOT correspond to any commit, which is
  // worth knowing: it is the state in which "I rebuilt it" is least reliable.
  const dirty = git("git status --porcelain -- . ../mobile") !== "";
  stamp = dirty ? `${sha} dirty` : sha;
} catch (err) {
  console.error(`stamp-build: could not read git HEAD — ${err.message.split("\n")[0]}`);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(target))) {
  console.error(`stamp-build: ${path.dirname(target)} does not exist — did the export run?`);
  process.exit(1);
}

fs.writeFileSync(target, `${stamp}\n`);
console.log(`stamp-build: ${outDir}/BUILD_SHA = ${stamp}`);
