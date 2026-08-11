import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { SPEC_TRUCKS } from "../src/data/uwcSpecTrucks";

/**
 * Guard: the COMPILED spec truck values (data/uwcSpecTrucks.ts, bundled into the
 * deployed container) must match the canonical docs/uwc-spec.json. If someone
 * edits docs/uwc-spec.json without re-running `npm run gen:spec`, this fails —
 * so "reset to spec" and a fresh seed can never silently diverge.
 *
 * This test is the READABLE half of that guard: it names which truck drifted.
 * It cannot be the whole guard, because it only protects a run it is included
 * in — a targeted `vitest run tests/interplantRate.test.ts` skips it entirely
 * and every pin reading the generated data passes against the stale copy
 * (measured 11 Aug 2026: 22/22 green with the source at RM9 and the generated
 * file at RM6). vitest.globalSetup.mjs is the half that fails EVERY run.
 */
describe("bundled spec trucks stay in sync with docs/uwc-spec.json", () => {
  it("matches docs/uwc-spec.json exactly (regenerate with `npm run gen:spec` if this fails)", () => {
    const specPath = path.resolve(__dirname, "../../docs/uwc-spec.json");
    const docs = JSON.parse(fs.readFileSync(specPath, "utf-8")) as { trucks: unknown[] };
    expect(SPEC_TRUCKS).toEqual(docs.trucks);
  });
});
