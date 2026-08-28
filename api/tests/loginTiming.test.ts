import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { BCRYPT_COST, dummyPasswordHash, burnPasswordCompare } from "../src/lib/loginTiming";

/**
 * `POST /auth/login` used to throw on an unknown phone BEFORE reaching
 * `bcrypt.compare`, so an unknown number answered ~100ms faster than a real one
 * while both returned the identical 401 body. One request per guess, no lockout
 * consumed, no audit row — a phone-number oracle hidden in a stopwatch.
 *
 * ⚠ THESE TESTS DO NOT MEASURE TIME. A wall-clock assertion on a shared CI
 * runner is a flake generator, and a flaky guard gets deleted or retried until
 * green, which is worse than no guard. What is actually asserted instead:
 *
 *   1. the dummy hash costs THE SAME as a real one (the property that makes the
 *      two branches take the same time);
 *   2. the login route REACHES the call (the property that puts it in the
 *      program at all).
 *
 * (2) is the one that matters. This repo's recurring defect is a correct
 * function nothing calls, and breaking `burnPasswordCompare` would prove only
 * that a test can see it. Prove this suite instead by DELETING the
 * `await burnPasswordCompare(password)` line from the route and watching the
 * last test go red.
 */
describe("the dummy hash costs what a real one costs", () => {
  it("is a real bcrypt hash", async () => {
    expect(await dummyPasswordHash()).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  /**
   * The whole point. A dummy hash at a LOWER cost than the real ones is
   * cheaper to compare, so the unknown-phone branch stays measurably faster and
   * the oracle survives — while every test that only checks "we called bcrypt"
   * keeps passing. Read the cost out of the hash itself rather than trusting
   * that it was built from the constant.
   */
  it("carries exactly BCRYPT_COST rounds", async () => {
    const rounds = Number((await dummyPasswordHash()).split("$")[2]);
    expect(rounds).toBe(BCRYPT_COST);
  });

  /**
   * ⚠ COST THE IMPORT, NOT JUST THE CALL. This hash was built with
   * `hashSync` at module load, which cost the whole parallel unit suite 9
   * seconds and timed out three real-app tests. Importing the module must be
   * free; the work belongs on first use.
   *
   * ⚠ `vi.resetModules()` IS LOAD-BEARING. The first version of this test
   * timed a bare `await import(...)` — but this file imports the module at the
   * top, so the dynamic import hit the module cache and measured nothing. It
   * PASSED with `hashSync` put back at module scope, which is the whole defect
   * it claims to catch. Resetting the registry forces the top-level code to run
   * again, which is the only thing worth timing here.
   */
  it("does no work until it is first called", async () => {
    vi.resetModules();
    const t0 = Date.now();
    await import("../src/lib/loginTiming");
    const cost = Date.now() - t0;
    expect(cost, `importing the module hashed something (${cost}ms)`).toBeLessThan(20);
  });

  it("computes the hash once and reuses it", async () => {
    expect(await dummyPasswordHash()).toBe(await dummyPasswordHash());
  });

  it("compares without throwing, and tells the caller nothing", async () => {
    await expect(burnPasswordCompare("whatever the attacker typed")).resolves.toBeUndefined();
  });
});

describe("BCRYPT_COST has exactly one definition", () => {
  /**
   * It was declared twice — routes/auth.ts and routes/me.ts each held their own
   * `const BCRYPT_COST = 10`. `lib/passwordPolicy` exists because the strength
   * floor drifted the same way. Here a drift is worse than untidy: raise the
   * cost in auth.ts alone and the dummy compare silently becomes the cheap
   * branch again, reopening the oracle with every test still green.
   */
  const SRC = path.resolve(__dirname, "../src");

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });

  it("is never re-declared outside lib/loginTiming", () => {
    const files = walk(SRC);
    // POSITIVE CONTROL. An empty walk produces an empty offender list, which is
    // also exactly what "no offenders" looks like — the failure this project
    // keeps shipping. Assert the walk actually visited the tree first.
    expect(files.length, "source walk visited nothing").toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith(path.join("routes", "auth.ts")))).toBe(true);

    const offenders = files.filter((f) => {
      if (f.endsWith(path.join("lib", "loginTiming.ts"))) return false;
      const src = codeOnly(fs.readFileSync(f, "utf-8"));
      return /(?:const|let|var)\s+BCRYPT_COST\s*=/.test(src);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

/**
 * ⚠ STRIP COMMENTS BEFORE SCANNING A SOURCE FILE. A positive assertion is
 * satisfied by a comment that merely MENTIONS the thing, so the code could stop
 * calling it and this would stay green; a negative assertion goes red on the
 * comment that EXPLAINS the fix. Both directions are wrong, and this repo has
 * hit each of them once. Same helper as mobile/src/lib/mytDay.test.ts.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the login route actually burns the compare", () => {
  const read = (rel: string) =>
    codeOnly(fs.readFileSync(path.resolve(__dirname, rel), "utf-8"));

  it("calls burnPasswordCompare on the unknown-phone branch", () => {
    const src = read("../src/routes/auth.ts");

    // POSITIVE CONTROL — the file is here and is the login route, so an empty
    // or moved file cannot pass by matching nothing.
    expect(src.length, "auth.ts moved or was renamed").toBeGreaterThan(2000);
    expect(src, "this is not the login route").toContain('router.post("/login"');

    expect(src, "must import the shared helper").toContain("burnPasswordCompare");

    // The call must sit between the user lookup and the throw — i.e. ON the
    // branch where there is no user. Matching the call anywhere in the file
    // would pass even if it were left in an unrelated handler.
    //
    // ⚠ Phase 5 (28 Aug 2026): the landmark moved from `lockoutConfig()` to
    // `effectiveLockoutConfig()` when the lockout thresholds became admin-
    // editable. A guard keyed on an exact string is a POSITIVE assertion that
    // is satisfied by nothing when the string changes — src.indexOf returns
    // -1, and slice(x, -1) silently degrades to "almost the whole file" rather
    // than failing loudly. Caught only by rereading this file while making
    // that rename; nothing would have gone red on its own.
    const landmark = "const lockout = await effectiveLockoutConfig();";
    expect(src, "the lockout-config landmark moved — update it here too").toContain(landmark);
    const branch = src.slice(src.indexOf('router.post("/login"'), src.indexOf(landmark));
    expect(branch.length, "login handler shape changed — re-read this guard").toBeGreaterThan(120);
    expect(branch, "the no-user branch must pay the bcrypt cost").toContain(
      "await burnPasswordCompare(password)"
    );
  });
});
