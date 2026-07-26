import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the push transport so "the alert fired exactly once" is a call-count
// assertion instead of a real Expo API hit. Hoisted above all imports.
vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { REQUESTOR, loginAs, prisma, resetDb } from "./helpers/harness";
import { bookTrip, firstRouteTypeId } from "./helpers/flow";
import {
  EXCEPTION_ALERT_THRESHOLD_MINUTES,
  resetExceptionAlertMarkers,
  sweepOverdueExceptions,
} from "../src/services/exceptionAlerts";
import { sendPushNotifications } from "../src/lib/pushNotifications";

/**
 * OVERDUE-EXCEPTION ALERT SWEEP — alert-only, flag-gated, one-shot.
 * Rows are seeded directly (the sweep only READS TripException; how a row got
 * there is the workflow suite's concern), with reported_at backdated past the
 * threshold. Each test drives sweepOverdueExceptions() directly — no timers.
 */

const pushMock = vi.mocked(sendPushNotifications);

const overdueInstant = () =>
  new Date(Date.now() - (EXCEPTION_ALERT_THRESHOLD_MINUTES + 1) * 60 * 1000);

function overdueAlertCount(exceptionId: string): number {
  return pushMock.mock.calls.filter(([, payload]) => {
    const data = payload?.data as { type?: string; exceptionId?: string } | undefined;
    return data?.type === "exception_overdue" && data?.exceptionId === exceptionId;
  }).length;
}

async function seedException(opts: { reportedAt: Date; closedAt?: Date | null }) {
  const requestor = await loginAs(REQUESTOR);
  const trip = await bookTrip(requestor, ["A1"], await firstRouteTypeId(requestor));
  const driver = await prisma.user.findFirst({ where: { role: "driver" }, select: { id: true } });
  return prisma.tripException.create({
    data: {
      trip_id: trip.id,
      client_occurrence_id: crypto.randomUUID(),
      category: "truck",
      reason: "sweep test — breakdown at the gate",
      reported_by: driver!.id,
      reported_at: opts.reportedAt,
      closed_at: opts.closedAt ?? null,
    },
  });
}

describe("overdue-exception alert sweep", () => {
  beforeEach(async () => {
    await resetDb();
    resetExceptionAlertMarkers();
    pushMock.mockClear();
    process.env.FEATURE_EXCEPTIONS = "true";
  });

  afterEach(() => {
    delete process.env.FEATURE_EXCEPTIONS;
  });

  it("is a NO-OP while the feature flag is off", async () => {
    const exc = await seedException({ reportedAt: overdueInstant() });
    delete process.env.FEATURE_EXCEPTIONS;

    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(0);
  });

  it("alerts an overdue OPEN exception exactly once (one-shot across sweeps)", async () => {
    const exc = await seedException({ reportedAt: overdueInstant() });

    await sweepOverdueExceptions();
    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(1);
  });

  it("ignores fresh and closed exceptions", async () => {
    const fresh = await seedException({ reportedAt: new Date() });
    const closed = await seedException({ reportedAt: overdueInstant(), closedAt: new Date() });

    await sweepOverdueExceptions();
    expect(overdueAlertCount(fresh.id)).toBe(0);
    expect(overdueAlertCount(closed.id)).toBe(0);
  });
});
