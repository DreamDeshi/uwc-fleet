import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR } from "../helpers/accounts";
import { cancelTrip, getDashboard, getTrip, login, setDispatchMode } from "../helpers/api";
import { seedUndispatchableTrip, seedPendingTrip } from "../helpers/seed";
import { resetState } from "../helpers/reset";

/**
 * FAILED AUTO-DISPATCH → PERSISTENT "NEEDS ATTENTION" STATE (Phase 2).
 *
 * Drives the shared backend through the API (the suite's pattern). Verifies the
 * self-clearing `auto_dispatch_failed` flag and the split dashboard KPIs:
 *   - auto mode + no eligible truck → trip stays pending AND flag is set;
 *   - a manual-mode pending booking is NOT flagged (awaiting-manual ≠ failed);
 *   - the flag self-clears the moment the trip leaves pending;
 *   - the dashboard reports failed-auto-dispatch separately from awaiting-manual.
 *
 * The "no eligible driver/truck" case is forced deterministically by putting
 * EVERY driver on leave for the trip's pickup date (a far-future day no other
 * spec books), so it never depends on which drivers happen to be busy on the
 * shared DB. (The old oversized-order trick is impossible now — creation
 * rejects cargo bigger than the largest truck, see creationValidation.spec.ts.)
 *
 * Note on clearing: the flag is cleared by the SAME `auto_dispatch_failed: false`
 * write on every transition out of pending — manual assign (claimPendingTrip),
 * a later auto-dispatch sweep that places it (claimPendingTrip), cancel, and
 * reject. The cancel test below exercises that write end-to-end.
 */
test.describe("Failed auto-dispatch → needs-attention state (Phase 2)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    adminToken = (await resetState()).adminToken;
  });

  test("auto mode with no eligible driver → pending + auto_dispatch_failed set", async () => {
    const requestor = await login(REQUESTOR);
    await setDispatchMode(adminToken, "auto");
    let cleanup = async () => {};
    try {
      const seeded = await seedUndispatchableTrip(adminToken, requestor.accessToken);
      cleanup = seeded.cleanup;
      // The create-time auto-dispatch attempt failed (every driver is on leave
      // for the pickup date): the trip stays pending and is flagged.
      const after = await getTrip(adminToken, seeded.trip.id);
      expect(after.status).toBe("pending");
      expect(after.auto_dispatch_failed).toBe(true);

      // Dashboard reports it as a FAILED auto-dispatch, distinct from awaiting-manual.
      const dash = await getDashboard(adminToken);
      expect(dash.auto_dispatch_failed).toBeGreaterThanOrEqual(1);
      // The two counts are reported as separate fields (failed ⊆ pending).
      expect(dash.awaiting_manual).toBe(dash.pending_trips - dash.auto_dispatch_failed);

      await cancelTrip(adminToken, seeded.trip.id);
    } finally {
      await cleanup();
      await setDispatchMode(adminToken, "manual");
    }
  });

  test("ordinary manual-mode pending booking is NOT flagged", async () => {
    const requestor = await login(REQUESTOR);
    // resetState leaves dispatch mode = manual, so no auto-dispatch runs on create.
    const trip = await seedPendingTrip(requestor.accessToken);
    const after = await getTrip(adminToken, trip.id);
    expect(after.status).toBe("pending");
    expect(after.auto_dispatch_failed).toBe(false);
    await cancelTrip(adminToken, trip.id);
  });

  test("the flag self-clears the moment the trip leaves pending", async () => {
    const requestor = await login(REQUESTOR);
    await setDispatchMode(adminToken, "auto");
    let cleanup = async () => {};
    try {
      const seeded = await seedUndispatchableTrip(adminToken, requestor.accessToken);
      cleanup = seeded.cleanup;
      expect((await getTrip(adminToken, seeded.trip.id)).auto_dispatch_failed).toBe(true);

      // Leaving pending (here via cancel — the same self-clearing write used by
      // manual assign and the retry sweep) resets the flag.
      await cancelTrip(adminToken, seeded.trip.id);
      const cleared = await getTrip(adminToken, seeded.trip.id);
      expect(cleared.status).toBe("cancelled");
      expect(cleared.auto_dispatch_failed).toBe(false);
    } finally {
      await cleanup();
      await setDispatchMode(adminToken, "manual");
    }
  });
});
