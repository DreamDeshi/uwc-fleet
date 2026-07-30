#!/usr/bin/env node
/**
 * E2E SELECTOR DRIFT GUARD
 *
 * Why this exists
 * ---------------
 * The driver-facing e2e suite was red for a week and nobody noticed. The
 * 29 Jul Home/ActiveTrip redesign renamed every entry point the specs clicked
 * — "Assignments", "View Trip Details", "View Navigation", the "Earnings" tab,
 * "POD photo uploaded", "Report Exception", "Submit report", "Upload Borang K2
 * form" — and the specs went on asserting the old words. A renamed label is
 * indistinguishable from a broken feature: both are "element not found". So a
 * suite that had stopped testing anything looked exactly like a suite with a
 * bug in it, and the failures got read as flake.
 *
 * The root cause is structural: an e2e selector is a copy of UI copy with
 * nothing tying the two together. Rename the copy and the duplicate rots in
 * silence. This script supplies the missing link.
 *
 * What it checks
 * --------------
 * Every LITERAL string the suite locates by — getByText("…"),
 * getByPlaceholder("…"), tapTab(page, "…"), shot(page, …, "…") — must be copy
 * the app can actually render: a value in mobile/src/i18n/en.json whose key is
 * REFERENCED somewhere in mobile/src. Values with {{interpolation}} are matched
 * by pattern.
 *
 * "Whose key is referenced" is the whole point, and the first version of this
 * script got it wrong. Checking only that the string exists in en.json passes
 * the very selectors that were broken: the redesign left
 * driver.todaysAssignments ("Assignments") and driver.viewNavigation
 * ("View Navigation") sitting in all three locale files after deleting the code
 * that rendered them. Dead copy is still copy, so the naive check approved a
 * locator pointing at something the app can no longer produce.
 *
 * It deliberately ignores regex locators: those are loose by intent, and a spec
 * that writes /POD (photo )?uploaded/ is explicitly saying either wording is fine.
 *
 * Escape hatch
 * ------------
 * Some selectors are legitimately not copy — a plate number, a consignee name,
 * a ringgit amount, text from a third-party surface. Exempt those with a
 * comment on the same or the previous line:
 *
 *     // selector-ok: plate comes from the fixture, not from i18n
 *     await page.getByText("PND 1888").click();
 *
 * A reason is required; a bare marker does not count, so the exempt list stays
 * readable instead of turning into a silent allowlist.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EN = join(REPO, "mobile", "src", "i18n", "en.json");
const E2E = join(REPO, "e2e");
const MOBILE_SRC = join(REPO, "mobile", "src");

// ── every string of copy, keyed ──────────────────────────────────────────
function flatten(node, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...flatten(v, key));
    else if (typeof v === "string") out.push([key, v]);
  }
  return out;
}
const entries = flatten(JSON.parse(readFileSync(EN, "utf8")));
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── which of it the app can actually render ──────────────────────────────
function filesUnder(dir, keep, skip = new Set()) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep, skip));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const appSource = filesUnder(
  MOBILE_SRC,
  (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)
)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

// Keys assembled at runtime, e.g. t(`exception.category.${c}`) — the whole
// namespace counts as referenced, since no single key appears literally.
const dynamicPrefixes = [
  ...new Set([...appSource.matchAll(/[`"']([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.\$\{/g)].map((m) => m[1])),
];
const PLURAL = ["_zero", "_one", "_two", "_few", "_many", "_other"];
const literallyReferenced = (k) =>
  appSource.includes(`"${k}"`) || appSource.includes(`'${k}'`) || appSource.includes(`\`${k}\``);

function isLive(key) {
  // i18next resolves plurals through the BASE key, so `results_one` is live
  // whenever `results` is referenced.
  const suffix = PLURAL.find((s) => key.endsWith(s));
  const base = suffix ? key.slice(0, -suffix.length) : key;
  if (literallyReferenced(key) || (base !== key && literallyReferenced(base))) return true;
  return dynamicPrefixes.some((p) => key.startsWith(p + "."));
}

const liveEntries = entries.filter(([k]) => isLive(k));
const deadEntries = entries.filter(([k]) => !isLive(k));

const exactLive = new Set(liveEntries.map(([, v]) => v));
const interpolatedLive = liveEntries
  .filter(([, v]) => v.includes("{{"))
  .map(([, v]) => new RegExp("^" + escapeRx(v).replace(/\\\{\\\{.*?\\\}\\\}/g, ".+") + "$"));
const isLiveCopy = (lit) => exactLive.has(lit) || interpolatedLive.some((r) => r.test(lit));

// A selector pointing at DEAD copy is the highest-signal case — name the key.
const deadByValue = new Map();
for (const [k, v] of deadEntries) if (!deadByValue.has(v)) deadByValue.set(v, k);

// ── walk the suite ───────────────────────────────────────────────────────
// Only DOUBLE-quoted literals: a backtick selector is a template, so dynamic
// by construction.
const PATTERNS = [
  /getBy(?:Text|Placeholder)\(\s*"([^"]*)"/g,
  /tapTab\(\s*page\s*,\s*"([^"]*)"/g,
  /shot\(\s*page\s*,\s*"[^"]*"\s*,\s*"([^"]*)"/g,
];
const EXEMPT = /\/\/\s*selector-ok:\s*\S+/;

const findings = [];
let checked = 0;

for (const file of filesUnder(E2E, (n) => n.endsWith(".ts"), new Set(["node_modules", "test-results", "scripts"]))) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rx of PATTERNS) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(line)) !== null) {
        const literal = m[1];
        if (literal === "") continue;
        checked += 1;
        if (isLiveCopy(literal)) continue;
        if (EXEMPT.test(line) || (i > 0 && EXEMPT.test(lines[i - 1]))) continue;
        findings.push({
          file: relative(REPO, file).replace(/\\/g, "/"),
          line: i + 1,
          literal,
          deadKey: deadByValue.get(literal) ?? null,
          nearest: nearestLive(literal),
        });
      }
    }
  });
}

/** Closest LIVE copy, so the fix is usually a copy-paste away. */
function nearestLive(lit) {
  let best = null;
  let bestScore = Infinity;
  const a = lit.toLowerCase();
  for (const [key, v] of liveEntries) {
    const b = v.toLowerCase();
    if (Math.abs(a.length - b.length) > 24) continue;
    const d = editDistance(a, b);
    if (d < bestScore) {
      bestScore = d;
      best = { key, value: v };
    }
  }
  return bestScore <= Math.max(6, lit.length * 0.6) ? best : null;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// ── report ───────────────────────────────────────────────────────────────
const out = [];
out.push(
  `Checked ${checked} literal selectors against ${liveEntries.length} live strings ` +
    `(${deadEntries.length} of ${entries.length} en.json strings are defined but rendered nowhere).`
);

if (findings.length === 0) {
  out.push("");
  out.push("No selector drift: every literal the suite locates by is copy the app can render.");
} else {
  out.push("");
  out.push(`${findings.length} selector(s) cannot match anything the app renders:`);
  for (const f of findings) {
    out.push("");
    out.push(`  ${f.file}:${f.line}`);
    out.push(`    looks for : ${JSON.stringify(f.literal)}`);
    if (f.deadKey) {
      out.push(`    DEAD KEY  : ${f.deadKey} still defines this string, but nothing renders it.`);
      out.push(`                The surface was renamed or removed — this selector cannot pass.`);
    }
    if (f.nearest) {
      out.push(`    closest   : ${JSON.stringify(f.nearest.value)}  (${f.nearest.key})`);
    } else if (!f.deadKey) {
      out.push(`    closest   : nothing similar — the surface may be gone entirely`);
    }
  }
  out.push("");
  out.push("Either the copy was renamed and the selector needs updating, or the string");
  out.push("is not copy at all — in which case mark it:");
  out.push("    // selector-ok: <why this is not i18n copy>");
}

const report = out.join("\n");
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## E2E selector drift\n\n\`\`\`\n${report}\n\`\`\`\n`, {
    flag: "a",
  });
}

process.exit(findings.length > 0 ? 1 : 0);
