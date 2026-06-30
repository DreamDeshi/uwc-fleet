import { test, expect } from "@playwright/test";
import { ADMIN, REQUESTOR } from "../helpers/accounts";
import { cancelTrip, getDashboard, getTrip, login, setDispatchMode } from "../helpers/api";
import { seedOversizedTrip, seedPendingTrip } from "../helpers/seed";
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
 * The "no eligible truck" case is forced deterministically with an oversized
 * order (20 pallets > the 16-pallet largest truck), so it never depends on which
 * other drivers happen to be busy on the shared DB.
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

  test("auto mode with no eligible truck → pending + auto_dispatch_failed set", async () => {
    const requestor = await login(REQUESTOR);
    await setDispatchMode(adminToken, "auto");
    try {
      const trip = await seedOversizedTrip(requestor.accessToken);
      // The create-time auto-dispatch attempt failed (no truck fits 20 pallets):
      // the trip stays pending and is flagged for admin attention.
      const after = await getTrip(adminToken, trip.id);
      expect(after.status).toBe("pending");
      expect(after.auto_dispatch_failed).toBe(true);

      // Dashboard reports it as a FAILED auto-dispatch, distinct from awaiting-manual.
      const dash = await getDashboard(adminToken);
      expect(dash.auto_dispatch_failed).toBeGreaterThanOrEqual(1);
      // The two counts are reported as separate fields (failed ⊆ pending).
      expect(dash.awaiting_manual).toBe(dash.pending_trips - dash.auto_dispatch_failed);

      await cancelTrip(adminToken, trip.id);
    } finally {
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
    try {
      const trip = await seedOversizedTrip(requestor.accessToken);
      expect((await getTrip(adminToken, trip.id)).auto_dispatch_failed).toBe(true);

      // Leaving pending (here via cancel — the same self-clearing write used by
      // manual assign and the retry sweep) resets the flag.
      await cancelTrip(adminToken, trip.id);
      const cleared = await getTrip(adminToken, trip.id);
      expect(cleared.status).toBe("cancelled");
      expect(cleared.auto_dispatch_failed).toBe(false);
    } finally {
      await setDispatchMode(adminToken, "manual");
    }
  });
});
