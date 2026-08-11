/**
 * The ONE renderer for src/data/uwcSpecTrucks.ts.
 *
 * Both the generator (`gen-spec.mjs`) and the run-level staleness gate
 * (`vitest.globalSetup.mjs`) render through this, so the guard cannot drift
 * from the thing it guards. "Stale" therefore has an exact definition: the file
 * on disk is not what `npm run gen:spec` would write right now.
 */

/** docs/uwc-spec.json, relative to the repo root — for error messages. */
export const SPEC_SOURCE_REL = "docs/uwc-spec.json";
/** The generated module, relative to the repo root — for error messages. */
export const GENERATED_REL = "api/src/data/uwcSpecTrucks.ts";

/**
 * Compare EOL-insensitively.
 *
 * This repo has `core.autocrlf=true` and no .gitattributes, so a checked-out
 * uwcSpecTrucks.ts arrives CRLF while this renderer emits LF. A byte-for-byte
 * comparison would fail on every fresh clone — the same class of false positive
 * as an mtime check.
 */
export function normaliseEol(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Render the full contents of src/data/uwcSpecTrucks.ts from a parsed spec. */
export function renderSpecTrucksModule(spec) {
  if (!spec || !Array.isArray(spec.trucks)) {
    throw new Error(`${SPEC_SOURCE_REL} has no trucks array.`);
  }

  return `// AUTO-GENERATED from docs/uwc-spec.json by \`npm run gen:spec\` — DO NOT EDIT BY HAND.
//
// docs/uwc-spec.json is the single source of truth, but it lives at the repo
// root (outside the API build scope), so it is NOT present in the deployed
// container. These values are compiled into dist/ instead.
//
// Two things stop this file drifting from docs/uwc-spec.json: tests/specSync.test.ts
// names WHICH truck drifted, and vitest.globalSetup.mjs fails the whole run —
// including a single-file run — so a pin that reads these values can never pass
// against a stale copy. Regenerate after editing the spec.
import type { SpecTruck } from "../lib/uwcSpec";

export const SPEC_TRUCKS: SpecTruck[] = ${JSON.stringify(spec.trucks, null, 2)};
`;
}
