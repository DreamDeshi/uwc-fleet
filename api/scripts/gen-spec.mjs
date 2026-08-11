/**
 * Generate src/data/uwcSpecTrucks.ts from the canonical docs/uwc-spec.json.
 *
 * Why: docs/uwc-spec.json lives at the repo root, OUTSIDE the API's build scope.
 * Railway builds the API with Root Directory = /api, so docs/ is not in the
 * container and cannot be read at runtime. Compiling the truck values into a TS
 * module guarantees they ship inside dist/.
 *
 * Run from anywhere:  npm run gen:spec --workspace api
 * docs/uwc-spec.json remains the single source of truth; regenerate after editing it.
 *
 * FAILURE IS LOUD, BY DESIGN. A silently failed generation leaves a STALE
 * uwcSpecTrucks.ts on disk, and every test that reads the generated values then
 * passes against yesterday's money. Paths resolve from THIS FILE rather than
 * process.cwd() (running from the repo root used to ENOENT on ../docs), every
 * failure prints what it wanted and exits non-zero, and vitest.globalSetup.mjs
 * fails the whole test run if this generator was not re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSpecTrucksModule,
  normaliseEol,
  SPEC_SOURCE_REL,
  GENERATED_REL,
} from "./renderSpecTrucks.mjs";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specPath = path.resolve(apiDir, "..", SPEC_SOURCE_REL);
const outPath = path.resolve(apiDir, "src/data/uwcSpecTrucks.ts");

function fail(message) {
  console.error(`gen-spec FAILED: ${message}`);
  console.error("  src/data/uwcSpecTrucks.ts was NOT rewritten and may now be STALE.");
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
} catch (err) {
  fail(`cannot read ${specPath}\n  ${err.message}`);
}

let body;
try {
  body = renderSpecTrucksModule(spec);
} catch (err) {
  fail(err.message);
}

try {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
} catch (err) {
  fail(`cannot write ${outPath}\n  ${err.message}`);
}

// Read back what actually landed: a write that silently truncates, or a file
// the renderer and the gate would disagree about, is the exact failure this
// script exists to make impossible.
const written = normaliseEol(fs.readFileSync(outPath, "utf-8"));
if (written !== normaliseEol(body)) {
  fail(`${GENERATED_REL} does not match what was just rendered.`);
}

console.log(`gen-spec: wrote ${spec.trucks.length} trucks → ${GENERATED_REL}`);
