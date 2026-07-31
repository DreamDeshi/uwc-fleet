/**
 * Prove the widened operating window holds for EVERY minute of the day.
 *
 * The suite's truck window is chosen at setup time from the wall clock, so a
 * bad choice is only visible if you happen to run in the wrong hour. One did:
 * `start = now - 1h` closed the operating day BEFORE a fixed 09:00 fixture
 * pickup whenever a run began after 10:00 MYT, and CI failed for a 3-hour band
 * every day — on whatever PR was unlucky enough to be in it.
 *
 * A test that only exercises the current minute cannot catch that. This walks
 * all 1440 of them, against the REAL rule from
 * api/src/services/operatingWindow.ts (windowEndInstant), and reports the worst
 * case. Run it in CI alongside the selector guard:
 *
 *     node e2e/scripts/check-window.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// ── read the two things under test out of the real sources, so this cannot
//    drift into testing a copy of itself ────────────────────────────────────
const setupSrc = readFileSync(join(HERE, "..", "setup.ts"), "utf8");
const seedSrc = readFileSync(join(HERE, "..", "helpers", "seed.ts"), "utf8");

const slackMatch = /const RUN_SLACK_MIN = (\d+);/.exec(setupSrc);
if (!slackMatch) throw new Error("check-window: RUN_SLACK_MIN not found in setup.ts");
const RUN_SLACK_MIN = Number(slackMatch[1]);

const fixtureBlock = /FIXED_PICKUP_MYT_MINUTES = \[([\s\S]*?)\] as const;/.exec(seedSrc);
if (!fixtureBlock) throw new Error("check-window: FIXED_PICKUP_MYT_MINUTES not found in helpers/seed.ts");
const FIXED_PICKUP_MYT_MINUTES = [...fixtureBlock[1].matchAll(/(\d+)\s*\*\s*60/g)].map((m) => Number(m[1]) * 60);
if (!FIXED_PICKUP_MYT_MINUTES.length) throw new Error("check-window: no fixture pickup minutes parsed");

// ── the setup's chooser, mirrored (kept in step by the assertions below) ────
const suitePickupMinutes = (nowMyt) => [...FIXED_PICKUP_MYT_MINUTES, (nowMyt - 5 + 1440) % 1440];
const slackFor = (tod, start, end) => (tod >= start ? 1440 - tod + end : end - tod);

function alwaysOpenWindow(nowMyt) {
  const tods = suitePickupMinutes(nowMyt);
  let best = { start: 1, end: 0, worstSlack: -Infinity };
  for (let start = 1; start < 1440; start++) {
    const end = start - 1;
    const worstSlack = Math.min(...tods.map((tod) => slackFor(tod, start, end)));
    if (worstSlack > best.worstSlack) best = { start, end, worstSlack };
  }
  return best;
}

// ── the REAL rule, verbatim from api/src/services/operatingWindow.ts ────────
const windowWraps = (startMin, endMin) => endMin <= startMin;
function windowEndInstant(date, startMin, endMin) {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const minutesMyt = myt.getUTCHours() * 60 + myt.getUTCMinutes();
  const rollsToNextDay = windowWraps(startMin, endMin) && minutesMyt >= startMin;
  return new Date(
    Date.UTC(
      myt.getUTCFullYear(),
      myt.getUTCMonth(),
      myt.getUTCDate() + (rollsToNextDay ? 1 : 0),
      0,
      endMin
    ) - MYT_OFFSET_MS
  );
}

// A fixed anchor day; only day arithmetic and time-of-day matter.
const BASE = Date.UTC(2026, 6, 15, 0, 0) - MYT_OFFSET_MS;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

let worst = { slack: Infinity };
const failures = [];

for (let nowMyt = 0; nowMyt < 1440; nowMyt++) {
  const win = alwaysOpenWindow(nowMyt);

  // The chooser's own arithmetic must agree with the real rule, not just with
  // itself — that is the whole point of importing windowEndInstant's logic.
  for (const tod of suitePickupMinutes(nowMyt)) {
    const pickup = new Date(BASE + tod * 60000);
    const endInstant = windowEndInstant(pickup, win.start, win.end);
    const realSlack = Math.round((endInstant.getTime() - pickup.getTime()) / 60000);
    const predicted = slackFor(tod, win.start, win.end);
    if (realSlack !== predicted) {
      failures.push(
        `${hhmm(nowMyt)} MYT: chooser predicted ${predicted} min of slack for a ${hhmm(tod)} pickup, ` +
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
  `✓ operating window holds for all 1440 start minutes — worst case ${worst.slack} min ` +
    `(needs ${RUN_SLACK_MIN}), at ${worst.at} MYT for a ${worst.tod} pickup ` +
    `under ${hhmm(worst.win.start)}-${hhmm(worst.win.end)}`
);
