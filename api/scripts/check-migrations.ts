/**
 * CI guard: refuse a migration that destroys data without a written reason.
 *
 * Merging a migration to `main` applies it to PRODUCTION immediately — Railway
 * auto-deploys `main` and `api/railway.json` runs `prisma migrate deploy` as its
 * preDeployCommand. There is no staging database and `main` requires zero
 * approving reviews. This is the gate that makes that path survivable.
 *
 * ── How to run ────────────────────────────────────────────────────────────
 *   npm run check:migrations --workspace api
 *   npm run check:migrations --workspace api -- --base origin/main
 *
 * `--base <ref>` additionally embeds the FULL SQL of every migration added
 * relative to <ref> into the GitHub step summary, so a migration cannot reach
 * production without its SQL being displayed on the pull request.
 *
 * ── Fixing a failure ──────────────────────────────────────────────────────
 * Do not delete the statement to get green, and do not weaken the rule. Either
 * rewrite the migration to be non-destructive, or — if the loss is intended —
 * put the override immediately above the statement:
 *
 *     -- DESTRUCTIVE-OK: JH/SL were placeholder zones Mr. Teh confirmed unused
 *     -- on 16 Jul 2026; these rows carry no points and no live consignee.
 *     DELETE FROM "DestinationRate" WHERE "zone_code" IN ('JH', 'SL');
 *
 * The marker must be adjacent to the statement, not blanket at the top of the
 * file, and the reason must be a real sentence. It lands in the diff and stays
 * in git history, which a pull-request label or a checkbox does not.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  MIN_REASON_CHARS,
  OVERRIDE_MARKER,
  scanMigration,
  type Finding,
  type MigrationReport,
} from "../src/lib/migrationSafety";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "prisma", "migrations");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readMigrations(): { name: string; file: string; sql: string }[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, file: path.join(MIGRATIONS_DIR, d.name, "migration.sql") }))
    .filter((m) => fs.existsSync(m.file))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ ...m, sql: fs.readFileSync(m.file, "utf8") }));
}

/** Migration directories ADDED relative to `base`. Best-effort: [] if git can't say. */
function migrationsAddedSince(base: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", "api/prisma/migrations"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const names = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith("migration.sql"))
      .map((l) => path.basename(path.dirname(l)));
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

function describe(f: Finding): string {
  if (f.justified) return `justified — ${f.reason}`;
  if (f.problem) return f.problem;
  return "NO override";
}

function appendStepSummary(body: string): void {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, body, "utf8");
  } catch (err) {
    console.warn(`could not write step summary: ${(err as Error).message}`);
  }
}

function buildSummary(
  reports: MigrationReport[],
  added: string[],
  addedSql: Map<string, string>
): string {
  const flagged = reports.filter((r) => r.findings.length > 0);
  const failing = reports.filter((r) => r.unjustified.length > 0);
  const lines: string[] = [];

  lines.push("## Migration safety scan", "");
  lines.push(
    failing.length === 0
      ? `✅ ${reports.length} migrations scanned — no unjustified destructive statements.`
      : `❌ ${failing.length} migration(s) contain destructive SQL with no \`${OVERRIDE_MARKER}\` override.`
  );
  lines.push("");

  if (added.length > 0) {
    lines.push(
      "### Migrations added by this change",
      "",
      "> Merging these applies them to **production** immediately — there is no gate after merge.",
      ""
    );
    for (const name of added) {
      lines.push(`<details open><summary><code>${name}</code></summary>`, "", "```sql");
      lines.push((addedSql.get(name) ?? "(unreadable)").trimEnd());
      lines.push("```", "", "</details>", "");
    }
  }

  if (flagged.length > 0) {
    lines.push("### Destructive statements", "", "| Migration | Line | Statement | Status |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of flagged) {
      for (const f of r.findings) {
        const status = f.justified ? `✅ ${f.reason}` : `❌ ${f.problem ?? "NO override"}`;
        lines.push(
          `| \`${r.name}\` | ${f.line} | ${f.label} | ${status.replace(/\|/g, "\\|")} |`
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function main(): void {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx !== -1 ? argv[baseIdx + 1] : undefined;

  const migrations = readMigrations();
  const reports = migrations.map((m) => scanMigration(m.name, m.sql));

  const added = base ? migrationsAddedSince(base) : [];
  const addedSql = new Map(
    migrations.filter((m) => added.includes(m.name)).map((m) => [m.name, m.sql])
  );

  console.log(`Scanning ${migrations.length} migrations in api/prisma/migrations\n`);
  if (base) {
    console.log(
      added.length > 0
        ? `Added since ${base}: ${added.join(", ")}\n`
        : `Added since ${base}: none\n`
    );
  }

  let failures = 0;
  for (const r of reports) {
    if (r.findings.length === 0) continue;
    console.log(`  ${r.name}`);
    for (const f of r.findings) {
      const mark = f.justified ? "ok  " : "FAIL";
      console.log(`    ${mark} L${f.line}  ${f.label.padEnd(16)} ${describe(f)}`);
      console.log(`         ${f.snippet}`);
    }
    console.log("");
    failures += r.unjustified.length;
  }

  appendStepSummary(buildSummary(reports, added, addedSql));

  if (failures === 0) {
    console.log(
      `PASS — ${migrations.length} migrations scanned, no unjustified destructive statements.`
    );
    return;
  }

  console.error(
    [
      `FAIL — ${failures} destructive statement(s) with no valid override.`,
      "",
      "Merging this applies it to PRODUCTION immediately: Railway auto-deploys",
      "main and runs `prisma migrate deploy` before the new code serves traffic.",
      "",
      "Either rewrite the migration to be non-destructive, or, if the loss is",
      "intended, put an override immediately above the statement:",
      "",
      `    -- ${OVERRIDE_MARKER} <why this data may be destroyed, ${MIN_REASON_CHARS}+ chars>`,
      "",
      "It must be adjacent to the statement — a blanket marker at the top of the",
      "file does not excuse the statements below it.",
    ].join("\n")
  );
  process.exitCode = 1;
}

// Guarded so importing this file can never run the scan as a side effect.
if (require.main === module) {
  main();
}
