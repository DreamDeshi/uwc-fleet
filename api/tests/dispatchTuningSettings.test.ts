import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * Phase 3 (28 Aug 2026) — dispatch.op_load_min / op_unload_min_per_stop /
 * op_drive_min_per_leg / op_drive_points_baseline / assignment_conflict_buffer_min.
 *
 * The resolvers themselves (dispatchTuningSettings.ts) are thin DB reads with
 * nothing to unit-test in isolation — same shape as bookingCutoffSettings.ts
 * and dispatchWindowSettings.ts's own resolver, neither of which has a
 * dedicated unit test either. `estimateOperatingWindow` and
 * `findSchedulingConflicts` are already exhaustively unit-tested as PURE
 * functions elsewhere (operatingWindow.test.ts, schedulingConflict callers).
 *
 * What's worth proving here, per AGENTS.md's "assert the guard is reached"
 * rule: that the two REAL call sites (manual approve in trips.ts, auto-dispatch
 * in dispatchEngine.ts) actually consult the resolved settings rather than the
 * old hardcoded constants — a unit test calling the pure functions directly
 * cannot tell "wired in" from "dead code accepting an unused parameter".
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 3 dispatch-tuning settings are wired into both assignment paths", () => {
  const tripsSrc = stripComments(readFileSync(join(__dirname, "..", "src", "routes", "trips.ts"), "utf8"));
  const engineSrc = stripComments(
    readFileSync(join(__dirname, "..", "src", "services", "dispatchEngine.ts"), "utf8")
  );

  it("the operating-window estimate in trips.ts (manual approve) passes the resolved op_* settings", () => {
    expect(tripsSrc).toContain("effectiveOperatingEstimateDefaults()");
    expect(tripsSrc).toContain("loadMin: opDefaults.loadMin");
    expect(tripsSrc).toContain("unloadMinPerStop: opDefaults.unloadMinPerStop");
    expect(tripsSrc).toContain("driveMinPerLeg: opDefaults.driveMinPerLeg");
    expect(tripsSrc).toContain("drivePointsBaseline: opDefaults.drivePointsBaseline");
  });

  it("the operating-window estimate in dispatchEngine.ts (auto-dispatch) passes the resolved op_* settings", () => {
    expect(engineSrc).toContain("effectiveOperatingEstimateDefaults()");
    expect(engineSrc).toContain("loadMin: opDefaults.loadMin");
    expect(engineSrc).toContain("unloadMinPerStop: opDefaults.unloadMinPerStop");
    expect(engineSrc).toContain("driveMinPerLeg: opDefaults.driveMinPerLeg");
    expect(engineSrc).toContain("drivePointsBaseline: opDefaults.drivePointsBaseline");
  });

  it("the scheduling-conflict buffer in trips.ts feeds BOTH the fetch window and findSchedulingConflicts", () => {
    expect(tripsSrc).toContain("effectiveAssignmentConflictBufferMs()");
    expect(tripsSrc).toContain("gte: new Date(pickup.getTime() - conflictBufferMs)");
    expect(tripsSrc).toContain("bufferMs: conflictBufferMs");
    // The hardcoded import must be GONE, not merely unused — a lingering
    // import is how a setting looks wired while a stale constant still governs.
    expect(tripsSrc).not.toContain("ASSIGNMENT_CONFLICT_BUFFER_MS");
  });

  it("the scheduling-conflict buffer in dispatchEngine.ts feeds BOTH the fetch window and the filter", () => {
    expect(engineSrc).toContain("effectiveAssignmentConflictBufferMs()");
    expect(engineSrc).toContain("gte: new Date(pickupMs - conflictBufferMs)");
    expect(engineSrc).toContain("Math.abs(x.pickup_datetime.getTime() - pickupMs) >= conflictBufferMs");
    expect(engineSrc).not.toContain("ASSIGNMENT_CONFLICT_BUFFER_MS");
  });
});
