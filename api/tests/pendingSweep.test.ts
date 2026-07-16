import { describe, it, expect } from "vitest";
import { staleSweepWhere } from "../src/services/pendingTripAlerts";

/**
 * Regression tripwire for the sweep dead-zone (audit 2026-07-16): the sweep's
 * trip selection must NOT filter on pending_alert_sent. When it did, the same
 * flag gated both the one-shot admin alert and the auto-dispatch retry, so an
 * alerted booking was never re-evaluated — a truck freeing up later never
 * picked it up. The one-shot alert is enforced per-trip inside the sweep loop,
 * not in this query. Behavior is covered by tests-integration/pendingSweep.
 */
describe("staleSweepWhere — retry selection is decoupled from alerting", () => {
  it("selects on status + age ONLY — no pending_alert_sent filter", () => {
    const cutoff = new Date("2026-07-16T00:00:00Z");
    expect(staleSweepWhere(cutoff)).toEqual({
      status: "pending",
      created_at: { lte: cutoff },
    });
  });

  it("never regains a pending_alert_sent key (the dead-zone bug)", () => {
    expect("pending_alert_sent" in staleSweepWhere(new Date())).toBe(false);
  });
});
