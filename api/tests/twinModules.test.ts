import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY api↔mobile TWIN MODULE MUST HAVE A DRIFT GUARD — AND THIS IS WHAT
 * NOTICES A NEW ONE.
 *
 * ── WHY, IN THE SHAPE OF FOUR BUGS ─────────────────────────────────────────
 *
 * The same rule written twice has been this codebase's most repeated defect:
 *
 *   pallets.ts              api and mobile hand-maintained twins. The booking
 *                           form's over-capacity warning and the server's
 *                           dispatch math must agree or the form warns on loads
 *                           that fit. Guarded by palletsMirror.test.ts.
 *   priorDeliveredDropsWhere  one Prisma where-shape, two services. Extracted.
 *   reports.ts tripOnTime   a private copy of lib/performanceScore's predicate.
 *                           The copies agreed ONLY because one pre-filtered, so
 *                           fixing the original left the other answering
 *                           differently. Deleted (PR #80).
 *   e2e alwaysOpenWindow    operatingWindow.spec kept a second chooser and used
 *                           it to RESTORE the truck window — so a fixed bug was
 *                           reinstated mid-run, and "4 failures -> 2" read as
 *                           progress. Extracted to one home (PR #78).
 *
 * Each was found one at a time, after it had already cost something. The point
 * of this file is to stop finding them that way.
 *
 * ── WHAT IT ENFORCES ───────────────────────────────────────────────────────
 *
 * A file name present in BOTH api/src/lib and mobile/src/lib is a TWIN: two
 * copies of one rule that no compiler, bundler or test relates to each other.
 * Cross-package duplication is UNAVOIDABLE here — separate runtimes, no shared
 * package — so the answer is not "delete one", it is "prove they agree".
 *
 * Every twin must therefore have a `<name>Mirror.test.ts` beside this file. A
 * new twin added later fails HERE, on the day it appears, instead of the day
 * the two copies disagree about money.
 *
 * ⚠ This checks that a guard EXISTS, not that it is good. A mirror test that
 * asserts nothing would satisfy it. That is deliberate — the alternative is a
 * generic auto-comparer, and palletsMirror is the argument against one: its
 * value is in the hand-built input matrix (messy spellings, NaN, empty cargo),
 * which no generic engine would have produced.
 */

const LIB_API = join(__dirname, "..", "src", "lib");
const LIB_MOBILE = join(__dirname, "..", "..", "mobile", "src", "lib");

const modulesIn = (dir: string): Set<string> =>
  new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.includes(".test."))
      .map((f) => f.replace(/\.ts$/, ""))
  );

/**
 * Twins that deliberately have NO mirror test, each with the reason. Empty
 * today, and it should stay hard to add to: an exemption is a decision that the
 * two copies are allowed to disagree, which is exactly the bug above.
 */
const EXEMPT: Record<string, string> = {};

describe("api↔mobile twin modules", () => {
  const twins = [...modulesIn(LIB_API)].filter((m) => modulesIn(LIB_MOBILE).has(m)).sort();

  it("there are twins to guard (this test is not vacuous)", () => {
    // If the directory layout changes and this finds nothing, the suite below
    // passes by checking zero files — the failure mode of every list-driven
    // guard. pallets is the twin that has existed longest.
    expect(twins.length).toBeGreaterThan(0);
    expect(twins).toContain("pallets");
  });

  it("every twin has a mirror test", () => {
    const missing = twins
      .filter((m) => !(m in EXEMPT))
      .filter((m) => !existsSync(join(__dirname, `${m}Mirror.test.ts`)));

    expect(
      missing,
      [
        "",
        "These modules exist in BOTH api/src/lib and mobile/src/lib with nothing",
        "keeping them in step:",
        ...missing.map((m) => `  ${m}.ts   ->  api/tests/${m}Mirror.test.ts is missing`),
        "",
        "Two copies of one rule drift silently: each side's own unit tests check",
        "it against its own numbers, so a one-sided edit passes both suites.",
        "Write the mirror test, or add the module to EXEMPT with a reason.",
        "",
      ].join("\n")
    ).toEqual([]);
  });

  it("no stale exemptions", () => {
    // An exemption for a module that is no longer a twin reads as a decision
    // someone made about live code. Same rule as the fail-closed allow-list.
    const stale = Object.keys(EXEMPT).filter((m) => !twins.includes(m));
    expect(stale, `EXEMPT names modules that are not twins: ${stale.join(", ")}`).toEqual([]);
  });
});
