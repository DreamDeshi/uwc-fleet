import fs from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  MIN_REASON_CHARS,
  findOverride,
  maskNonCode,
  scanMigration,
} from "../src/lib/migrationSafety";

/**
 * The guard behind `npm run check:migrations`. It matters because merging a
 * migration to `main` applies it to PRODUCTION with no gate in between, so this
 * scanner is the only thing standing between a careless DELETE and live pay data.
 *
 * Every "does not flag" case below is a REAL construct from this repo's
 * migrations, not an invented edge case.
 */

const kinds = (sql: string): string[] => scanMigration("t", sql).findings.map((f) => f.kind);
const unjustified = (sql: string): string[] =>
  scanMigration("t", sql).unjustified.map((f) => f.kind);

describe("maskNonCode", () => {
  it("blanks line comments but preserves length and line numbering", () => {
    const sql = 'SELECT 1;\n-- DROP TABLE "Trip";\nSELECT 2;';
    const masked = maskNonCode(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked).not.toMatch(/DROP/i);
  });

  it("blanks nested block comments (Postgres allows nesting)", () => {
    const sql = 'A /* outer /* inner DROP TABLE "x" */ still comment */ B';
    expect(maskNonCode(sql)).not.toMatch(/DROP/i);
  });

  it("blanks string contents but keeps the quotes", () => {
    const sql = "INSERT INTO \"t\" VALUES ('DROP TABLE \"Trip\"');";
    const masked = maskNonCode(sql);
    expect(masked).not.toMatch(/DROP/i);
    expect(masked).toMatch(/INSERT INTO "t" VALUES \('/);
  });

  it("treats '' inside a string as an escaped quote, not a terminator", () => {
    const sql = "SELECT 'it''s DROP TABLE here'; SELECT 1;";
    expect(maskNonCode(sql)).not.toMatch(/DROP/i);
  });

  it("survives a literal containing a double dash (the encoded-polyline case)", () => {
    // 20260720160000_route_legs embeds huge encoded polylines full of arbitrary
    // bytes. A naive comment stripper would treat the -- as a comment start and
    // swallow the rest of the line, including real SQL.
    const sql = "INSERT INTO \"RouteLeg\" VALUES ('oyy^--aadR');\nDELETE FROM \"Zone\";";
    expect(kinds(sql)).toContain("delete");
  });

  it("blanks dollar-quoted bodies", () => {
    const sql = "DO $$ BEGIN DROP TABLE \"Trip\"; END $$;";
    expect(maskNonCode(sql)).not.toMatch(/DROP/i);
  });

  it("keeps double-quoted identifiers intact so they still match", () => {
    expect(kinds('DELETE FROM "DestinationRate" WHERE 1=1;')).toEqual(["delete"]);
  });
});

describe("destructive detection", () => {
  it("flags the DDL family", () => {
    expect(kinds('DROP TABLE "Trip";')).toContain("drop_table");
    expect(kinds('ALTER TABLE "Trip" DROP COLUMN "pay";')).toContain("drop_column");
    expect(kinds('ALTER TABLE "T" DROP CONSTRAINT "c";')).toContain("drop_constraint");
    expect(kinds('DROP INDEX "i";')).toContain("drop_index");
    expect(kinds('DROP TYPE "ChangeRequestStatus";')).toContain("drop_object");
    expect(kinds('TRUNCATE "Trip";')).toContain("truncate");
  });

  it("flags DML — where this repo's real destructive history lives", () => {
    expect(kinds('DELETE FROM "DestinationRate" WHERE "zone_code" = \'JH\';')).toContain("delete");
    expect(kinds("UPDATE \"Truck\" SET \"operating_hours_end\" = '02:00';")).toContain("update");
  });

  it("flags a multi-line UPDATE … FROM … SET with an alias", () => {
    // The shape in 20260702140000_rate_lock_snapshots. An `UPDATE "x" SET`-only
    // pattern misses it entirely.
    const sql = 'UPDATE "Trip" AS t\nSET "a" = tr."a"\nFROM "Truck" AS tr\nWHERE t."id" = tr."id";';
    expect(kinds(sql)).toEqual(["update"]);
  });

  it("does NOT flag ON DELETE / ON UPDATE referential actions", () => {
    const sql =
      'ALTER TABLE "TripChangeRequest" ADD CONSTRAINT "fk" FOREIGN KEY ("trip_id")' +
      ' REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;';
    expect(kinds(sql)).toEqual([]);
  });

  it("does NOT flag ON UPDATE CASCADE followed by an unrelated SET in the same statement", () => {
    const sql =
      'ALTER TABLE "T" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "U"("b")' +
      ' ON UPDATE CASCADE, ALTER COLUMN "c" SET DEFAULT 1;';
    expect(kinds(sql)).toEqual([]);
  });

  it("does NOT flag a DROP that only appears in a comment", () => {
    // The exact reason comment-stripping exists: 20260729160000_trip_change_request
    // quotes the line it deliberately removed.
    const sql = [
      "-- `prisma migrate diff` emitted this line, and it has been REMOVED:",
      "--",
      '--     ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT',
      '--       "ExceptionEvidence_action_same_exception_fkey";',
      "",
      'CREATE TABLE "TripChangeRequest" ("id" TEXT NOT NULL);',
    ].join("\n");
    expect(kinds(sql)).toEqual([]);
  });

  it("does not double-report a DROP CONSTRAINT as a bare ALTER … DROP", () => {
    expect(kinds('ALTER TABLE "T" DROP CONSTRAINT "c";')).toEqual(["drop_constraint"]);
  });

  it("flags a bare ALTER TABLE … DROP with no COLUMN keyword", () => {
    expect(kinds('ALTER TABLE "T" DROP "col";')).toContain("alter_drop");
  });

  it("reports the line of the keyword, not of the statement separator", () => {
    const sql = 'SELECT 1;\n\n\nDELETE FROM "Zone";';
    expect(scanMigration("t", sql).findings[0]?.line).toBe(4);
  });
});

describe("the DESTRUCTIVE-OK override", () => {
  const stmt = 'DELETE FROM "Zone" WHERE "code" = \'JH\';';

  it("accepts a marker on the line immediately above", () => {
    const sql = `-- DESTRUCTIVE-OK: placeholder zone confirmed unused by the client\n${stmt}`;
    expect(unjustified(sql)).toEqual([]);
  });

  it("accepts a marker earlier in the same contiguous comment block", () => {
    const sql = [
      "-- DESTRUCTIVE-OK: placeholder zone confirmed unused by the client",
      "-- and carrying no points in the rate sheet.",
      stmt,
    ].join("\n");
    expect(unjustified(sql)).toEqual([]);
  });

  it("accepts a trailing marker on the statement's own line", () => {
    expect(unjustified(`${stmt} -- DESTRUCTIVE-OK: unused placeholder zone`)).toEqual([]);
  });

  it("works on CRLF files", () => {
    // Migrations here are a MIX of LF and CRLF; a trailing \r used to defeat the
    // reason capture, silently reporting every CRLF override as absent.
    const sql = `-- DESTRUCTIVE-OK: placeholder zone confirmed unused\r\n${stmt}\r\n`;
    expect(unjustified(sql)).toEqual([]);
  });

  it("REJECTS a blanket marker separated from the statement by other SQL", () => {
    const sql = [
      "-- DESTRUCTIVE-OK: this file is allowed to be destructive",
      'CREATE TABLE "x" ("id" TEXT);',
      "",
      stmt,
    ].join("\n");
    expect(unjustified(sql)).toEqual(["delete"]);
  });

  it("REJECTS a marker with no reason", () => {
    const r = scanMigration("t", `-- DESTRUCTIVE-OK:\n${stmt}`);
    expect(r.unjustified).toHaveLength(1);
    expect(r.unjustified[0]?.problem).toMatch(new RegExp(`${MIN_REASON_CHARS}`));
  });

  it("REJECTS a token reason too short to mean anything", () => {
    expect(unjustified(`-- DESTRUCTIVE-OK: ok\n${stmt}`)).toEqual(["delete"]);
  });

  it("requires a separate marker for each statement", () => {
    const sql = [
      "-- DESTRUCTIVE-OK: the rate rows for a placeholder zone, confirmed unused",
      'DELETE FROM "DestinationRate" WHERE "zone_code" = \'JH\';',
      "",
      'DELETE FROM "Zone" WHERE "code" = \'JH\';',
    ].join("\n");
    expect(unjustified(sql)).toEqual(["delete"]);
  });
});

describe("the committed migration corpus", () => {
  it("has no unjustified destructive statements", () => {
    // Fails locally on `npm test`, before CI, if someone adds a destructive
    // migration without a reason — or strips a backfilled marker.
    const dir = path.resolve(__dirname, "..", "prisma", "migrations");
    const offenders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, file: path.join(dir, d.name, "migration.sql") }))
      .filter((m) => fs.existsSync(m.file))
      .map((m) => scanMigration(m.name, fs.readFileSync(m.file, "utf8")))
      .filter((r) => r.unjustified.length > 0)
      .map((r) => `${r.name}: ${r.unjustified.map((f) => `L${f.line} ${f.label}`).join(", ")}`);

    expect(offenders).toEqual([]);
  });
});
