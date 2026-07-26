import { describe, expect, it } from "vitest";
import {
  EXCEPTION_ALERT_THRESHOLD_MINUTES,
  overdueUnalerted,
} from "../src/services/exceptionAlerts";

// Pure selection logic for the overdue-open-exception sweep. The DB/push side
// is exercised by running sweepOverdueExceptions in the integration tier; this
// pins the threshold arithmetic and the one-shot exclusion.

const THRESHOLD_MS = EXCEPTION_ALERT_THRESHOLD_MINUTES * 60 * 1000;
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);

function exc(id: string, ageMs: number) {
  return { id, reported_at: new Date(NOW - ageMs) };
}

describe("overdueUnalerted", () => {
  it("selects only exceptions open at least the threshold", () => {
    const open = [
      exc("young", THRESHOLD_MS - 60_000),
      exc("exact", THRESHOLD_MS),
      exc("old", THRESHOLD_MS + 60_000),
    ];
    const due = overdueUnalerted(open, new Set(), NOW);
    expect(due.map((e) => e.id)).toEqual(["exact", "old"]);
  });

  it("excludes already-alerted exceptions (one-shot)", () => {
    const open = [exc("a", THRESHOLD_MS * 2), exc("b", THRESHOLD_MS * 2)];
    const due = overdueUnalerted(open, new Set(["a"]), NOW);
    expect(due.map((e) => e.id)).toEqual(["b"]);
  });

  it("returns nothing when everything is fresh or already alerted", () => {
    expect(overdueUnalerted([exc("young", 1000)], new Set(), NOW)).toEqual([]);
    expect(overdueUnalerted([exc("old", THRESHOLD_MS * 3)], new Set(["old"]), NOW)).toEqual([]);
  });
});
