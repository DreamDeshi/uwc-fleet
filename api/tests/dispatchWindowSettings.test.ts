import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { resolveTruckWindow } from "../src/lib/dispatchWindowSettings";

/**
 * Phase 2 (28 Aug 2026) — dispatch.window_start/window_end. Registered so an
 * admin CAN edit the fleet's fallback operating window, but its reach is
 * narrow BY DESIGN: every real Truck row carries its own operating_hours
 * (schema default, NOT NULL), already admin-editable on the Trucks screen,
 * and that per-truck value always wins. `resolveTruckWindow` is the merge
 * that decides between the two, pulled out of dispatchEngine.ts (DB
 * orchestration, not directly unit-testable) so this can prove it precisely.
 */
describe("resolveTruckWindow — the admin default is reachable ONLY when the truck itself is missing", () => {
  // Deliberately NOT operatingWindow.ts's real defaults (07:00/02:00) — a test
  // that silently ignored the `defaults` argument would still show 07:00/02:00
  // here and this would catch it.
  const defaults = { windowStart: "06:00", windowEnd: "23:00" };

  it("a truck with its own hours always wins, even against a different default", () => {
    const truck = { operating_hours_start: "07:00", operating_hours_end: "02:00" };
    expect(resolveTruckWindow(truck, defaults)).toEqual({ windowStart: "07:00", windowEnd: "02:00" });
  });

  it("falls back to the admin default when the truck itself is undefined", () => {
    expect(resolveTruckWindow(undefined, defaults)).toEqual(defaults);
  });

  it("falls back to the admin default when the truck's own fields are null", () => {
    const truck = { operating_hours_start: null, operating_hours_end: null };
    expect(resolveTruckWindow(truck, defaults)).toEqual(defaults);
  });

  // Per AGENTS.md: a unit test calling a pure function directly proves the
  // test can SEE the function, never that anything else CALLS it. Scan the
  // one real call site instead of trusting this file alone.
  it("IS ACTUALLY CALLED from dispatchEngine.ts's auto-dispatch window check", () => {
    const src = readFileSync(join(__dirname, "..", "src", "services", "dispatchEngine.ts"), "utf8");
    // Strip comments both directions, per the source-guard rule: a positive
    // scan must not pass on a comment merely mentioning the call.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).toContain("resolveTruckWindow(selTruck, dispatchWindowDefaults)");
  });
});
