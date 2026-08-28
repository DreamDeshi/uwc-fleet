import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the push transport so "the alert fired exactly once" is a call-count
// assertion instead of a real Expo API hit. Hoisted above all imports.
vi.mock("../src/lib/pushNotifications", () => ({
  sendPushNotifications: vi.fn(async () => {}),
}));

import { REQUESTOR, ADMIN, loginAs, prisma, resetDb, api, auth } from "./helpers/harness";
import { bookTrip, firstRouteTypeId } from "./helpers/flow";
import {
  EXCEPTION_ALERT_THRESHOLD_MINUTES,
  alertExceptionReported,
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

function reportedAlertCount(exceptionId: string): number {
  return pushMock.mock.calls.filter(([, payload]) => {
    const data = payload?.data as { type?: string; exceptionId?: string } | undefined;
    return data?.type === "exception_reported" && data?.exceptionId === exceptionId;
  }).length;
}

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

  it("PATCHing alert.exception_threshold_min changes when the sweep considers an exception overdue", async () => {
    // Admin-settings Phase 4 (28 Aug 2026) — proves the SWEEP actually reads
    // the effective setting, not just that overdueUnalerted accepts an
    // override parameter in isolation (tests/exceptionAlerts.test.ts).
    const admin = await loginAs(ADMIN);
    // 20 minutes open — under the DEFAULT 30-minute threshold, not yet overdue.
    const exc = await seedException({ reportedAt: new Date(Date.now() - 20 * 60 * 1000) });

    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(0);

    const patch = await api()
      .patch("/api/v1/settings/alert.exception_threshold_min")
      .set(auth(admin))
      .send({ value: 10 });
    expect(patch.status).toBe(200);

    // The SAME exception, now overdue under the shrunk threshold.
    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(1);
  });
});

/**
 * AT-REPORT ALERT — the admin hears the moment a driver files, not up to 30
 * minutes later. The trip is paused from the instant the report commits, so
 * the sweep alone meant a loaded truck could sit stranded for half an hour
 * before anyone was told.
 */
describe("at-report exception alert", () => {
  beforeEach(async () => {
    await resetDb();
    resetExceptionAlertMarkers();
    pushMock.mockClear();
    process.env.FEATURE_EXCEPTIONS = "true";
  });
  afterEach(() => {
    delete process.env.FEATURE_EXCEPTIONS;
  });

  it("fires immediately for a FRESH report — the case the sweep ignores", async () => {
    const exc = await seedException({ reportedAt: new Date() });
    // The sweep would do nothing with this one: it is not overdue.
    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(0);

    await alertExceptionReported(exc.id);
    expect(reportedAlertCount(exc.id)).toBe(1);
  });

  it("carries the truck and the reason, so a lock screen is actionable", async () => {
    const exc = await seedException({ reportedAt: new Date() });
    await alertExceptionReported(exc.id);
    const call = pushMock.mock.calls.find(([, p]) => {
      const d = p?.data as { exceptionId?: string } | undefined;
      return d?.exceptionId === exc.id;
    });
    expect(call).toBeDefined();
    const [, payload] = call!;
    expect(payload.title).toContain("truck"); // the category
    expect(payload.body).toContain("breakdown at the gate"); // the driver's words
    expect(payload.body).toMatch(/paused/i); // and what it means
  });

  it("is a NO-OP while the feature flag is off", async () => {
    const exc = await seedException({ reportedAt: new Date() });
    delete process.env.FEATURE_EXCEPTIONS;
    await alertExceptionReported(exc.id);
    expect(reportedAlertCount(exc.id)).toBe(0);
  });

  it("NEVER throws — a push failure must not fail a committed report", async () => {
    // His evidence photo is uploaded and the trip is already paused; losing the
    // report would be far worse than losing the notification.
    const exc = await seedException({ reportedAt: new Date() });
    pushMock.mockRejectedValueOnce(new Error("expo is down"));
    await expect(alertExceptionReported(exc.id)).resolves.toBeUndefined();
    // And a vanished exception is not an error either.
    await expect(alertExceptionReported("does-not-exist")).resolves.toBeUndefined();
  });

  it("the 30-minute sweep STILL escalates one nobody actioned", async () => {
    // Both alerts survive on purpose and say different things: "a driver just
    // reported X" vs "nobody has acted on this in 30 minutes". The sweep must
    // not treat the at-report ping as having handled it.
    const exc = await seedException({ reportedAt: overdueInstant() });
    await alertExceptionReported(exc.id);
    expect(reportedAlertCount(exc.id)).toBe(1);

    await sweepOverdueExceptions();
    expect(overdueAlertCount(exc.id)).toBe(1);
  });
});
