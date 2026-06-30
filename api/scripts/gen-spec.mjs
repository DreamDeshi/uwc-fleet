/**
 * Generate src/data/uwcSpecTrucks.ts from the canonical docs/uwc-spec.json.
 *
 * Why: docs/uwc-spec.json lives at the repo root, OUTSIDE the API's build scope.
 * Railway builds the API with Root Directory = /api, so docs/ is not in the
 * container and cannot be read at runtime. Compiling the truck values into a TS
 * module guarantees they ship inside dist/. tests/specSync.test.ts asserts the
 * generated values still match docs/uwc-spec.json, so they can never diverge.
 *
 * Run from the api/ workspace:  npm run gen:spec
 * docs/uwc-spec.json remains the single source of truth; regenerate after editing it.
 */
import fs from "node:fs";
import path from "node:path";

const specPath = path.resolve(process.cwd(), "../docs/uwc-spec.json");
const outPath = path.resolve(process.cwd(), "src/data/uwcSpecTrucks.ts");

const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
if (!Array.isArray(spec.trucks)) {
  throw new Error("docs/uwc-spec.json has no trucks array.");
}

const body = `// AUTO-GENERATED from docs/uwc-spec.json by \`npm run gen:spec\` — DO NOT EDIT BY HAND.
//
// docs/uwc-spec.json is the single source of truth, but it lives at the repo
// root (outside the API build scope), so it is NOT present in the deployed
// container. These values are compiled into dist/ instead. tests/specSync.test.ts
// fails if this file drifts from docs/uwc-spec.json — regenerate after editing it.
import type { SpecTruck } from "../lib/uwcSpec";

export const SPEC_TRUCKS: SpecTruck[] = ${JSON.stringify(spec.trucks, null, 2)};
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body);
console.log(`gen-spec: wrote ${spec.trucks.length} trucks → src/data/uwcSpecTrucks.ts`);
