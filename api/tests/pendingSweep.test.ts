import { describe, it, expect } from "vitest";
import {
  staleSweepWhere,
  pendingRetryExpired,
  PENDING_RETRY_CEILING_MINUTES,
  alreadyEscalated,
  retryCeilingNote,
  PICKUP_PASSED_NOTE,
} from "../src/services/pendingTripAlerts";

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

  it("an explicit retryCeilingMs override moves the ceiling (Phase 4, admin-editable)", () => {
    // At the module default (24h), 30 minutes stuck is nowhere near expired.
    expect(pendingRetryExpired(mkTrip(2 * 60 * 60 * 1000, 30 * 60 * 1000), now)).toBeNull();
    // An admin shrinking the ceiling to 20 minutes expires that same booking.
    expect(pendingRetryExpired(mkTrip(2 * 60 * 60 * 1000, 30 * 60 * 1000), now, 20 * 60 * 1000)).toBe(
      "retry_ceiling"
    );
  });
});

/**
 * THE STALE-MARKER BUG (Phase 4, 28 Aug 2026) — found while wiring
 * PENDING_RETRY_CEILING_MINUTES up as an admin setting, before it shipped.
 *
 * The one-shot "already escalated" check used to be an exact-string Set built
 * from `EXPIRY_NOTE`, which embeds the ceiling minutes in its text. Once that
 * number could change at runtime (an admin edits the setting), a trip
 * escalated under the OLD number would stop matching a Set rebuilt from the
 * NEW number on the very next sweep — so it would be silently re-escalated: a
 * duplicate "Booking expired" push for something an admin had already been
 * told about. This pins the fix: matching a STABLE prefix instead of the full
 * (variable) string.
 */
describe("alreadyEscalated — survives a live change to the retry-ceiling setting", () => {
  it("recognises a note written under an OLD ceiling value as already escalated", () => {
    const noteFromLastWeek = retryCeilingNote(1440); // yesterday's admin setting
    expect(alreadyEscalated(noteFromLastWeek)).toBe(true);
    // The admin has since shrunk the ceiling to 60 minutes — a note generated
    // under the NEW value looks different, but the OLD one must still count.
    const noteUnderNewSetting = retryCeilingNote(60);
    expect(noteFromLastWeek).not.toBe(noteUnderNewSetting); // the bug's precondition
    expect(alreadyEscalated(noteFromLastWeek)).toBe(true); // and the fix holds anyway
  });

  it("still recognises the stable pickup-passed note", () => {
    expect(alreadyEscalated(PICKUP_PASSED_NOTE)).toBe(true);
  });

  it("does NOT treat an ordinary in-window failure note as already escalated", () => {
    // The engine's per-attempt failure notes are unrelated free text (e.g. "No
    // available truck…") — those must keep being retried, not skipped.
    expect(alreadyEscalated("No available truck for this route.")).toBe(false);
    expect(alreadyEscalated(null)).toBe(false);
  });
});
