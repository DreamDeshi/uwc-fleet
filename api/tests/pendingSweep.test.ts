import { describe, it, expect } from "vitest";
import { staleSweepWhere, pendingRetryExpired, PENDING_RETRY_CEILING_MINUTES } from "../src/services/pendingTripAlerts";

/**
 * Regression tripwire for the sweep dead-zone (audit 2026-07-16): the sweep's
 * trip selection must NOT filter on pending_alert_sent. When it did, the same
 * flag gated both the one-shot admin alert and the auto-dispatch retry, so an
 * alerted booking was never re-evaluated — a truck freeing up later never
 * picked it up. The one-shot alert is enforced per-trip inside the sweep loop,
 * not in this query. Behavior is covered by tests-integration/pendingSweep.
 */
describe("staleSweepWhere — retry selection is decoupled from alerting", () => {
  it("selects on status + age + not-manually-paused — no pending_alert_sent filter", () => {
    const cutoff = new Date("2026-07-16T00:00:00Z");
    expect(staleSweepWhere(cutoff)).toEqual({
      status: "pending",
      created_at: { lte: cutoff },
      auto_dispatch_paused: false, // feedback item 15: skip manually-held trips
    });
  });

  it("never regains a pending_alert_sent key (the dead-zone bug)", () => {
    expect("pending_alert_sent" in staleSweepWhere(new Date())).toBe(false);
  });

  it("excludes manually-held (unassigned) trips so they're never auto-re-dispatched", () => {
    // feedback item 15: an admin who unassigns pins the trip to manual — the
    // sweep must not claim it back. The predicate carries the exclusion.
    expect(staleSweepWhere(new Date()).auto_dispatch_paused).toBe(false);
  });
});

/**
 * The retry CEILING (DG-T1): the decoupling fix above removed the only thing
 * that ever stopped the retry, so a rotting booking re-dispatched every minute
 * forever. `pendingRetryExpired` is the pure cap — once pickup passes (a
 * days-late assignment helps no one) or a generous age backstop trips, the
 * sweep gives up and escalates to manual.
 */
describe("pendingRetryExpired — the retry ceiling", () => {
  const now = Date.parse("2026-07-16T08:00:00Z");
  const mkTrip = (pickupOffsetMs: number, ageMs: number) => ({
    pickup_datetime: new Date(now + pickupOffsetMs),
    created_at: new Date(now - ageMs),
  });

  it("keeps retrying a fresh booking whose pickup is still ahead", () => {
    expect(pendingRetryExpired(mkTrip(2 * 60 * 60 * 1000, 11 * 60 * 1000), now)).toBeNull();
  });

  it("expires once the pickup moment has passed (no days-late auto-assign)", () => {
    expect(pendingRetryExpired(mkTrip(-1000, 11 * 60 * 1000), now)).toBe("pickup_passed");
    expect(pendingRetryExpired(mkTrip(0, 11 * 60 * 1000), now)).toBe("pickup_passed"); // exactly at pickup
  });

  it("expires a far-future booking that has sat past the age ceiling", () => {
    const pastCeiling = (PENDING_RETRY_CEILING_MINUTES + 1) * 60 * 1000;
    // pickup still days ahead, but it has been stuck longer than the backstop.
    expect(pendingRetryExpired(mkTrip(72 * 60 * 60 * 1000, pastCeiling), now)).toBe("retry_ceiling");
  });

  it("prefers the pickup-passed reason when both would trip", () => {
    const pastCeiling = (PENDING_RETRY_CEILING_MINUTES + 1) * 60 * 1000;
    expect(pendingRetryExpired(mkTrip(-1000, pastCeiling), now)).toBe("pickup_passed");
  });
});
