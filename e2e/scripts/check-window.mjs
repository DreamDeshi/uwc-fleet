/**
 * Prove the run-wide truck window holds at EVERY minute of the day — and that
 * there is only ONE of it.
 *
 * Two separate failures, both of which shipped green:
 *
 *   1. `start = now - 1h` closed the operating day BEFORE the suite's fixed
 *      09:00 fixture pickup whenever a run began after 10:00 MYT. CI failed for
 *      185 minutes a day (10:01-13:05 MYT = 02:01-05:05 UTC) on whatever PR was
 *      unlucky. A check that only exercises the current minute cannot see that,
 *      so this walks all 1440.
 *
 *   2. operatingWindow.spec.ts kept a SECOND COPY of the chooser to restore the
 *      window after narrowing it. Fixing the first one left the duplicate
 *      reinstating the bug MID-RUN — and because the suite is serial, every
 *      spec after it inherited the bad window. The first fix went from four
 *      failures to two and looked like progress. So this also fails if the
 *      arithmetic reappears anywhere outside its one home.
 *
 * Run: node e2e/scripts/check-window.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = join(HERE, "..");
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOME = join(E2E, "helpers", "runWideWindow.ts");

// ── read the real sources, so this cannot drift into testing a copy of itself ─
const homeSrc = readFileSync(HOME, "utf8");
const seedSrc = readFileSync(join(E2E, "helpers", "seed.ts"), "utf8");

const slackMatch = /export const RUN_SLACK_MIN = (\d+);/.exec(homeSrc);
if (!slackMatch) throw new Error("check-window: RUN_SLACK_MIN not found in helpers/runWideWindow.ts");
const RUN_SLACK_MIN = Number(slackMatch[1]);

const fixtureBlock = /FIXED_PICKUP_MYT_MINUTES = \[([\s\S]*?)\] as const;/.exec(seedSrc);
if (!fixtureBlock) throw new Error("check-window: FIXED_PICKUP_MYT_MINUTES not found in helpers/seed.ts");
const FIXED_PICKUP_MYT_MINUTES = [...fixtureBlock[1].matchAll(/(\d+)\s*\*\s*60/g)].map((m) => Number(m[1]) * 60);
if (!FIXED_PICKUP_MYT_MINUTES.length) throw new Error("check-window: no fixture pickup minutes parsed");

// ── PART 1: nobody else computes a run-wide window ──────────────────────────
// The signature of the old bug, and of any hand-rolled replacement: deriving a
// window start by subtracting from the current MYT minute-of-day.
const DUPLICATE = /Math\.floor\(\s*\((?:Date\.now\(\)|now\.getTime\(\))\s*\+\s*8\s*\*/;
const offenders = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test-results" || name === "playwright-report") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(ts|mts|mjs)$/.test(name)) continue;
    if (full === HOME) continue; // the one legitimate home
    if (DUPLICATE.test(readFileSync(full, "utf8"))) offenders.push(relative(E2E, full));
  }
})(E2E);

if (offenders.length) {
  console.error(
    "✗ a SECOND copy of the run-wide window arithmetic exists — import runWideWindow\n" +
      "  from helpers/runWideWindow.ts instead. A duplicate silently reinstates the bug\n" +
      "  mid-run, and the suite is serial, so every spec after it inherits the bad window.\n"
  );
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}

// ── PART 2: the chooser holds at every minute, against the REAL rule ────────
const suitePickupMinutes = (nowMyt) => [...FIXED_PICKUP_MYT_MINUTES, (nowMyt - 5 + 1440) % 1440];
const slackFor = (tod, start, end) => (tod >= start ? 1440 - tod + end : end - tod);

function runWideWindow(nowMyt) {
  const tods = suitePickupMinutes(nowMyt);
  let best = { start: 1, end: 0, worstSlack: -Infinity };
  for (let start = 1; start < 1440; start++) {
    const end = start - 1;
    const worstSlack = Math.min(...tods.map((tod) => slackFor(tod, start, end)));
    if (worstSlack > best.worstSlack) best = { start, end, worstSlack };
  }
  return best;
}

// windowEndInstant, verbatim from api/src/services/operatingWindow.ts.
const windowWraps = (startMin, endMin) => endMin <= startMin;
function windowEndInstant(date, startMin, endMin) {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const minutesMyt = myt.getUTCHours() * 60 + myt.getUTCMinutes();
  const rollsToNextDay = windowWraps(startMin, endMin) && minutesMyt >= startMin;
  return new Date(
    Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() + (rollsToNextDay ? 1 : 0), 0, endMin) -
      MYT_OFFSET_MS
  );
}

const BASE = Date.UTC(2026, 6, 15, 0, 0) - MYT_OFFSET_MS;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

let worst = { slack: Infinity };
const failures = [];

for (let nowMyt = 0; nowMyt < 1440; nowMyt++) {
  const win = runWideWindow(nowMyt);
  for (const tod of suitePickupMinutes(nowMyt)) {
    const pickup = new Date(BASE + tod * 60000);
    const realSlack = Math.round((windowEndInstant(pickup, win.start, win.end).getTime() - pickup.getTime()) / 60000);
    const predicted = slackFor(tod, win.start, win.end);
    // The chooser must agree with the REAL rule, not merely with itself.
    if (realSlack !== predicted) {
      failures.push(
        `${hhmm(nowMyt)} MYT: chooser predicted ${predicted} min for a ${hhmm(tod)} pickup, ` +
          `windowEndInstant gives ${realSlack}`
      );
    }
    if (realSlack < worst.slack) worst = { slack: realSlack, at: hhmm(nowMyt), tod: hhmm(tod), win };
    if (realSlack < RUN_SLACK_MIN) {
      failures.push(
        `${hhmm(nowMyt)} MYT: a ${hhmm(tod)} pickup gets ${realSlack} min under window ` +
          `${hhmm(win.start)}-${hhmm(win.end)} (needs ${RUN_SLACK_MIN})`
      );
    }
  }
}

if (failures.length) {
  console.error(`✗ operating-window check FAILED for ${failures.length} case(s):\n`);
  for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
  if (failures.length > 20) console.error(`  ... and ${failures.length - 20} more`);
  process.exit(1);
}

console.log(
  `✓ one chooser, and it holds for all 1440 start minutes — worst case ${worst.slack} min ` +
    `(needs ${RUN_SLACK_MIN}), at ${worst.at} MYT for a ${worst.tod} pickup ` +
    `under ${hhmm(worst.win.start)}-${hhmm(worst.win.end)}`
);
