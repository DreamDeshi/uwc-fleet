import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

/**
 * THE BUILD STAMP MUST NOT BE ABLE TO FAIL THE DEPLOY.
 *
 * `mobile/scripts/stamp-build.mjs` exited 1 when `git rev-parse HEAD` failed.
 * The Railway builder copies the SOURCE, not the repository — there is no
 * `.git` — so from the moment that script landed (PR #145, 12 Aug 2026 02:13)
 * every mobile web deploy failed at the last step, AFTER `expo export` had
 * already produced a working bundle. The trial link served the 11 Aug build for
 * the next nine hours while `main` moved five commits ahead, and Railway showed
 * the service "Online" the whole time, because the previous deployment was
 * still up. Nothing alerts on a failed deploy.
 *
 * ⚠ WHY NO EXISTING TEST COULD HAVE CAUGHT IT, and why this file is here: the
 * e2e job runs `npx expo export --platform web` DIRECTLY. Nothing in CI runs
 * `npm run build:web`, so the Railway builder was the only consumer of that
 * script anywhere on earth. These cases run the real script as a subprocess,
 * from a directory that is deliberately NOT a git repository — the one
 * condition that mattered and the one nobody could reproduce by running it
 * normally.
 *
 * It lives under src/ because `npm test` in mobile/ is `vitest run src`; a spec
 * beside the script would never execute.
 */

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "stamp-build.mjs");

/**
 * Copy the script into a throwaway tree and run it there. The script derives
 * its working directory from its OWN location, so this is what puts it outside
 * a git repository — exactly the builder's situation.
 */
function runInTempTree(opts: { git?: boolean; env?: Record<string, string>; makeDist?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-build-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "stamp-build.mjs"));
  if (opts.makeDist !== false) fs.mkdirSync(path.join(root, "dist"));

  if (opts.git) {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    g("add", ".");
    g("commit", "-qm", "one");
  }

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [path.join(root, "scripts", "stamp-build.mjs")], {
      cwd: root,
      env: { ...process.env, RAILWAY_GIT_COMMIT_SHA: "", SOURCE_COMMIT: "", GITHUB_SHA: "", ...opts.env },
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    status = e.status ?? 1;
    stderr = e.stderr?.toString() ?? "";
  }

  const shaFile = path.join(root, "dist", "BUILD_SHA");
  const stamp = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, "utf8").trim() : null;
  const head = opts.git
    ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim()
    : null;
  fs.rmSync(root, { recursive: true, force: true });
  return { status, stderr, stamp, head };
}

describe("stamp-build — the deploy must survive a builder with no .git", () => {
  it("does NOT fail the build outside a git repository", () => {
    // THE REGRESSION. Before the fix this exited 1, and that single exit code
    // is what kept the trial on a stale bundle for nine hours.
    const run = runInTempTree({});
    expect(run.status).toBe(0);
    expect(run.stamp).toBe("unknown");
  });

  it("takes the commit from the deploy platform when git is unavailable", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const run = runInTempTree({ env: { RAILWAY_GIT_COMMIT_SHA: sha } });
    expect(run.status).toBe(0);
    expect(run.stamp).toBe(sha);
  });

  it("prefers the REPOSITORY over the environment when both are present", () => {
    // Order matters: only git can tell a dirty tree from a clean one, and a
    // local rebuild must stamp what is actually checked out — not whatever a
    // leftover env var claims.
    const run = runInTempTree({ git: true, env: { RAILWAY_GIT_COMMIT_SHA: "f".repeat(40) } });
    expect(run.status).toBe(0);
    expect(run.stamp).toBe(run.head);
  });

  it("still fails when the export did not run — that IS a broken build", () => {
    // The one case that must keep exiting 1: no dist/ means `expo export`
    // produced nothing, and shipping that would serve an empty site.
    const run = runInTempTree({ makeDist: false });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("did the export run?");
  });

  it("an unidentifiable bundle can never satisfy the freshness gate", () => {
    // e2e/handover-run.mjs compares the served stamp with `git rev-parse HEAD`.
    // "unknown" is not a 40-char sha, so it cannot collide with any commit —
    // the deploy proceeds and the verification tool still refuses to trust it.
    const run = runInTempTree({});
    expect(run.stamp).not.toMatch(/^[0-9a-f]{40}$/);
  });
});
