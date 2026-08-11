/**
 * RUN-LEVEL GATE: fail the ENTIRE vitest run when src/data/uwcSpecTrucks.ts is
 * stale — when it is not what `npm run gen:spec` would write right now.
 *
 * WHY tests/specSync.test.ts IS NOT ENOUGH
 *
 * That test only protects a run it is INCLUDED in. Every pin that reads the
 * generated data — INTERPLANT_FALLBACK_RATE against PLX 2406's interplant row,
 * the "exactly two interplant trucks" assertion, `loadSpecTrucks()` anywhere —
 * passes happily against a stale file in a targeted run.
 *
 * Measured 11 Aug 2026: docs/uwc-spec.json drifted to RM9 with the generated
 * file left at RM6, then `vitest run tests/interplantRate.test.ts` → 22/22
 * GREEN, including the pin that exists to catch exactly that. A targeted run is
 * precisely what you do when checking whether a guard works, so a `gen:spec`
 * that failed could make a pin look proven while it checked nothing.
 *
 * globalSetup runs once per vitest invocation regardless of which files are
 * filtered in, so staleness now fails the run instead of hiding inside it.
 *
 * DELIBERATELY NOT AN MTIME COMPARISON. git checkout stamps files at checkout
 * time in index order, and "api/..." is written BEFORE "docs/...", so on a fresh
 * clone the generated file is ALREADY older than its source (measured: 87ms).
 * An mtime assertion would go red on every clean CI run. Content is the truth.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSpecTrucksModule,
  normaliseEol,
  SPEC_SOURCE_REL,
  GENERATED_REL,
} from "./scripts/renderSpecTrucks.mjs";

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(apiDir, "..", SPEC_SOURCE_REL);
const generatedPath = path.resolve(apiDir, "src/data/uwcSpecTrucks.ts");

const REGENERATE = "Run `npm run gen:spec --workspace api` and commit the result.";

/** First line that differs, so the failure names the drift instead of dumping the file. */
function firstDifference(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [
        `  first difference at line ${i + 1}:`,
        `    ${SPEC_SOURCE_REL} would generate: ${(a[i] ?? "<end of file>").trim().slice(0, 160)}`,
        `    ${GENERATED_REL} has:            ${(b[i] ?? "<end of file>").trim().slice(0, 160)}`,
      ].join("\n");
    }
  }
  return "";
}

export default function setup() {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `spec staleness gate: cannot read ${SPEC_SOURCE_REL}\n  ${err.message}\n  ` +
        `Every pin that reads the generated truck data is unverified until this is readable.`
    );
  }

  const expected = normaliseEol(renderSpecTrucksModule(spec));

  let actual;
  try {
    actual = normaliseEol(fs.readFileSync(generatedPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `spec staleness gate: ${GENERATED_REL} is missing or unreadable.\n  ${err.message}\n  ${REGENERATE}`
    );
  }

  if (expected !== actual) {
    throw new Error(
      `spec staleness gate: ${GENERATED_REL} is STALE — it does not match ${SPEC_SOURCE_REL}.\n` +
        `${firstDifference(expected, actual)}\n` +
        `  The whole run is failed rather than the one test, because tests that read the\n` +
        `  generated truck data (rate pins, fallback pins, dispatch pools) would otherwise\n` +
        `  pass against the stale copy and prove nothing.\n  ${REGENERATE}`
    );
  }
}
