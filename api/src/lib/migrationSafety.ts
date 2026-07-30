/**
 * Destructive-SQL detection for committed Prisma migrations.
 *
 * WHY THIS EXISTS: merging a migration to `main` applies it to PRODUCTION with
 * no gate in between — `api/railway.json` sets
 * `preDeployCommand: npm run migrate:deploy` and Railway auto-deploys `main`.
 * `main` also requires zero approving reviews, so the author of a migration is
 * usually its only reader. This module is the content-based gate that a CI job
 * (`npm run check:migrations --workspace api`) turns into a required check.
 *
 * It is a BUILD/CI helper, not server code — nothing in src/ imports it. It
 * lives here so it is covered by `npm run typecheck` and the unit suite, the
 * same as every other pure helper.
 *
 * TWO DESIGN POINTS THAT MATTER:
 *
 * 1. Comments and string literals are MASKED before scanning. A naive grep
 *    fails `20260729160000_trip_change_request`, whose header comment quotes
 *    `ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT` verbatim in order to
 *    explain why that line was deleted — i.e. the migration that documents
 *    doing the right thing would be the one the guard rejects. Migrations here
 *    also embed enormous encoded-polyline literals (see
 *    20260720160000_route_legs) that contain arbitrary `--` byte sequences.
 *
 * 2. It covers DML, not just DDL. Three of the four genuinely destructive
 *    statements in this repo's history are `DELETE FROM` / `UPDATE … SET`, and
 *    `20260718000000_remove_jh_sl_zones` deletes from `DestinationRate` — a
 *    MONEY table feeding zone points into driver pay. A DDL-only rule catches
 *    one of the four and misses that one entirely.
 *
 * KNOWN UNCOVERED (deliberate, see AGENTS.md): statements that are destructive
 * by LOCKING rather than by dropping — `SET NOT NULL`, adding a NOT NULL column
 * with a default, a non-`CONCURRENTLY` index build on a large table — and
 * type-narrowing `ALTER COLUMN … TYPE` casts.
 */

export type DestructiveKind =
  | "drop_table"
  | "drop_column"
  | "drop_constraint"
  | "drop_index"
  | "drop_object"
  | "alter_drop"
  | "truncate"
  | "delete"
  | "update";

export interface Finding {
  kind: DestructiveKind;
  /** Human label for the statement class, e.g. "DELETE FROM". */
  label: string;
  /** 1-based line number of the offending keyword in the original file. */
  line: number;
  /** The original source line, trimmed. */
  snippet: string;
  /** True when an adjacent `-- DESTRUCTIVE-OK:` comment justifies it. */
  justified: boolean;
  /** The justification text, when present and valid. */
  reason?: string;
  /** Set when a marker was found but rejected (e.g. reason too short). */
  problem?: string;
}

export interface MigrationReport {
  /** Migration directory name, e.g. "20260718000000_remove_jh_sl_zones". */
  name: string;
  findings: Finding[];
  /** Findings lacking a valid adjacent override. Non-empty ⇒ CI fails. */
  unjustified: Finding[];
}

/** The in-SQL override. Must sit adjacent to the statement it excuses. */
export const OVERRIDE_MARKER = "DESTRUCTIVE-OK:";

/**
 * A reason shorter than this is treated as absent. Stops `-- DESTRUCTIVE-OK:`
 * and `-- DESTRUCTIVE-OK: ok` from becoming a reflex that means nothing.
 */
export const MIN_REASON_CHARS = 10;

/** Truncation width for the reported source line. */
const MAX_SNIPPET = 160;

/**
 * Blank out everything that is not executable SQL, preserving BOTH the original
 * length and every newline so byte offsets and line numbers still map 1:1 back
 * onto the source.
 *
 * Masked: line comments (`--`), block comments (`/* *\/`, nested — Postgres
 * allows nesting), single-quoted string CONTENTS, and dollar-quoted string
 * CONTENTS. Double-quoted identifiers are skipped over but left intact, because
 * they are code (`DELETE FROM "DestinationRate"` must still match).
 */
export function maskNonCode(sql: string): string {
  const out = sql.split("");
  const n = sql.length;

  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(to, n); k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };

  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    // -- line comment
    if (two === "--") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    // /* block comment */ — nested, per Postgres
    if (two === "/*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.slice(j, j + 2) === "/*") {
          depth++;
          j += 2;
        } else if (sql.slice(j, j + 2) === "*/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    // 'single-quoted string' — '' is an escaped quote, not a terminator
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      // Keep the quote characters, blank the contents.
      blank(i + 1, closed ? j - 1 : n);
      i = j;
      continue;
    }

    // $tag$ dollar-quoted string $tag$
    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          blank(i + tag.length, n);
          i = n;
        } else {
          blank(i + tag.length, end);
          i = end + tag.length;
        }
        continue;
      }
    }

    // "quoted identifier" — skipped, not blanked ("" is an escaped quote)
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    i++;
  }

  return out.join("");
}

interface Rule {
  kind: DestructiveKind;
  label: string;
  /** Matched against the MASKED sql. `[^;]` bounds keep matches inside one statement. */
  re: RegExp;
  /** Locates the keyword inside the match, so the reported line is the keyword's. */
  kw: RegExp;
}

const RULES: Rule[] = [
  { kind: "drop_table", label: "DROP TABLE", re: /\bDROP\s+TABLE\b/gi, kw: /\bDROP\b/i },
  { kind: "drop_column", label: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi, kw: /\bDROP\b/i },
  {
    kind: "drop_constraint",
    label: "DROP CONSTRAINT",
    re: /\bDROP\s+CONSTRAINT\b/gi,
    kw: /\bDROP\b/i,
  },
  { kind: "drop_index", label: "DROP INDEX", re: /\bDROP\s+INDEX\b/gi, kw: /\bDROP\b/i },
  {
    kind: "drop_object",
    label: "DROP <object>",
    re: /\bDROP\s+(?:TYPE|SCHEMA|DATABASE|VIEW|SEQUENCE|TRIGGER|FUNCTION|MATERIALIZED\s+VIEW)\b/gi,
    kw: /\bDROP\b/i,
  },
  {
    // Bare `ALTER TABLE t DROP c` (no COLUMN/CONSTRAINT keyword). The lookahead
    // stops this double-reporting the two rules above.
    kind: "alter_drop",
    label: "ALTER … DROP",
    re: /\bALTER\s+TABLE\b[^;]*?\bDROP\b(?!\s+(?:COLUMN|CONSTRAINT)\b)/gi,
    kw: /\bDROP\b(?!\s+(?:COLUMN|CONSTRAINT)\b)/i,
  },
  { kind: "truncate", label: "TRUNCATE", re: /\bTRUNCATE\b/gi, kw: /\bTRUNCATE\b/i },
  {
    // Unanchored is safe: `ON DELETE RESTRICT` cannot produce `DELETE FROM`.
    kind: "delete",
    label: "DELETE FROM",
    re: /\bDELETE\s+FROM\b/gi,
    kw: /\bDELETE\b/i,
  },
  {
    // ANCHORED to a statement start (or a CTE's opening paren) on purpose:
    // unanchored, `… ON UPDATE CASCADE, ALTER COLUMN x SET …` would false-positive.
    kind: "update",
    label: "UPDATE … SET",
    re: /(?:^|;|\()\s*UPDATE\b[^;]*?\bSET\b/gi,
    kw: /\bUPDATE\b/i,
  },
];

/** 1-based line number for a byte offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Is there a valid `-- DESTRUCTIVE-OK: <reason>` for the statement on `line`?
 *
 * Accepted positions, and only these: a trailing comment on the statement's own
 * line, or the contiguous run of `--` comment lines immediately above it (blank
 * lines allowed between). Deliberately NOT file-wide — one blanket marker at the
 * top must not excuse every statement below it, and `remove_jh_sl_zones` has two
 * separate DELETEs that each deserve their own sentence.
 */
export function findOverride(
  lines: string[],
  line: number
): { found: boolean; reason?: string; problem?: string } {
  const candidates: string[] = [];

  // Strip CR defensively: this repo's migrations are a MIX of LF and CRLF, and a
  // trailing \r silently defeats the `(.*)$` capture below — `.` does not match a
  // line terminator, so the marker parses as absent on exactly the CRLF files.
  const at = (i: number): string => (lines[i] ?? "").replace(/\r$/, "");

  const own = at(line - 1);
  if (own.includes(OVERRIDE_MARKER)) candidates.push(own);

  for (let i = line - 2; i >= 0; i--) {
    const text = at(i);
    if (text.trim() === "") continue;
    if (!/^\s*--/.test(text)) break;
    candidates.push(text);
  }

  let sawMarker = false;
  for (const c of candidates) {
    const m = new RegExp(`${OVERRIDE_MARKER}\\s*(.*)$`).exec(c);
    if (!m) continue;
    sawMarker = true;
    const reason = (m[1] ?? "").trim();
    if (reason.length >= MIN_REASON_CHARS) return { found: true, reason };
  }

  if (sawMarker) {
    return {
      found: false,
      problem: `override present but the reason is shorter than ${MIN_REASON_CHARS} characters`,
    };
  }
  return { found: false };
}

/** Scan one migration's SQL. */
export function scanMigration(name: string, sql: string): MigrationReport {
  const masked = maskNonCode(sql);
  const lines = sql.split(/\r?\n/);
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const rel = rule.kw.exec(m[0])?.index ?? 0;
      const line = lineAt(masked, m.index + rel);

      // One report per (kind, line): a single line rarely holds two of the same.
      const key = `${rule.kind}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const override = findOverride(lines, line);
      findings.push({
        kind: rule.kind,
        label: rule.label,
        line,
        snippet: (lines[line - 1] ?? "").trim().slice(0, MAX_SNIPPET),
        justified: override.found,
        ...(override.reason ? { reason: override.reason } : {}),
        ...(override.problem ? { problem: override.problem } : {}),
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return { name, findings, unjustified: findings.filter((f) => !f.justified) };
}
