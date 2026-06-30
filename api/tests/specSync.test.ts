import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { SPEC_TRUCKS } from "../src/data/uwcSpecTrucks";

/**
 * Guard: the COMPILED spec truck values (data/uwcSpecTrucks.ts, bundled into the
 * deployed container) must match the canonical docs/uwc-spec.json. If someone
 * edits docs/uwc-spec.json without re-running `npm run gen:spec`, this fails —
 * so "reset to spec" and a fresh seed can never silently diverge.
 */
describe("bundled spec trucks stay in sync with docs/uwc-spec.json", () => {
  it("matches docs/uwc-spec.json exactly (regenerate with `npm run gen:spec` if this fails)", () => {
    const specPath = path.resolve(__dirname, "../../docs/uwc-spec.json");
    const docs = JSON.parse(fs.readFileSync(specPath, "utf-8")) as { trucks: unknown[] };
    expect(SPEC_TRUCKS).toEqual(docs.trucks);
  });
});
