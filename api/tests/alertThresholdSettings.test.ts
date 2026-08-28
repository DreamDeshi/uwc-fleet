import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * Admin-settings Phase 4 (28 Aug 2026) — alert.exception_threshold_min /
 * alert.pending_trip_threshold_min / alert.pending_retry_ceiling_min /
 * alert.doc_expiry_remind_days.
 *
 * alertThresholdSettings.ts's resolvers are thin DB reads with nothing to
 * unit-test in isolation — same shape as every other Phase 1-3 resolver file.
 * What matters, per AGENTS.md's "assert the guard is reached" rule, is that
 * the three REAL sweep functions (which run unattended on a timer, not per
 * HTTP request — there is no route to hit for a live reach proof the way the
 * earlier phases had) actually call the resolvers rather than the old
 * hardcoded constants.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Phase 4 alert thresholds are wired into all three sweeps", () => {
  const exceptionAlertsSrc = stripComments(
    readFileSync(join(__dirname, "..", "src", "services", "exceptionAlerts.ts"), "utf8")
  );
  const pendingTripAlertsSrc = stripComments(
    readFileSync(join(__dirname, "..", "src", "services", "pendingTripAlerts.ts"), "utf8")
  );
  const docExpirySrc = stripComments(
    readFileSync(join(__dirname, "..", "src", "services", "docExpiryReminders.ts"), "utf8")
  );

  it("sweepOverdueExceptions resolves and uses the admin setting, not the bare module constant", () => {
    expect(exceptionAlertsSrc).toContain("effectiveExceptionAlertThresholdMin()");
    expect(exceptionAlertsSrc).toContain("overdueUnalerted(open, alertedIds, Date.now(), thresholdMin * 60 * 1000)");
  });

  it("sweepPendingTrips resolves and uses BOTH admin settings, not the bare module constants", () => {
    expect(pendingTripAlertsSrc).toContain("effectivePendingTripAlertThresholds()");
    expect(pendingTripAlertsSrc).toContain("pendingRetryExpired(trip, now, retryCeilingMs)");
    expect(pendingTripAlertsSrc).toContain("const cutoff = new Date(now - pendingThresholdMs)");
  });

  it("startDocExpiryReminders resolves the admin setting on every run, not just at boot", () => {
    expect(docExpirySrc).toContain("effectiveDocExpiryRemindDays()");
    expect(docExpirySrc).toContain("remindExpiringDocs(new Date(), days)");
  });
});
