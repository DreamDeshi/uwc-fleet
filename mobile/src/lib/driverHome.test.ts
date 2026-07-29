import { describe, it, expect } from "vitest";
import { buildDriverDay, currentStopNumber, stopProgress } from "./driverHome";
import type { Trip, TripStatus, StopStatus } from "../types";

const NOW = new Date("2026-07-29T09:00:00+08:00");

let seq = 0;
const trip = (
  status: TripStatus,
  pickup: string,
  stops: StopStatus[] = ["pending"]
): Trip =>
  ({
    id: `t${++seq}`,
    ticket_number: `TKT-${seq}`,
    requestor_id: "r1",
    driver_id: "d1",
    truck_plate: "PND 1888",
    route_type_id: "rt1",
    status,
    pickup_datetime: pickup,
    incentive_earned: null,
    is_external: false,
    created_at: pickup,
    stops: stops.map((st, i) => ({
      id: `${seq}-${i}`,
      trip_id: `t${seq}`,
      sequence: i + 1,
      consignee_id: `c${i}`,
      status: st,
      arrived_at: null,
      delivered_at: null,
      pod_photo: null,
      do_uploaded: false,
      k2_photo: null,
      k2_form_ack: false,
    })),
  }) as Trip;

describe("buildDriverDay — which of the five shapes Home is in", () => {
  it("nothing at all → no_trips", () => {
    const day = buildDriverDay([], NOW);
    expect(day.state).toBe("no_trips");
    expect(day.primary).toBeNull();
    expect(day.tripCount).toBe(0);
  });

  it("assigned today, nothing run yet → before, and that trip is primary", () => {
    const a = trip("assigned", "2026-07-29T09:00:00+08:00", ["pending", "pending"]);
    const day = buildDriverDay([a], NOW);
    expect(day.state).toBe("before");
    expect(day.primary?.id).toBe(a.id);
    expect(day.stopCount).toBe(2);
  });

  it("a trip in progress wins the primary slot over an earlier assigned one", () => {
    const later = trip("assigned", "2026-07-29T13:30:00+08:00");
    const live = trip("in_progress", "2026-07-29T09:00:00+08:00", ["delivered", "pending"]);
    const day = buildDriverDay([later, live], NOW);
    expect(day.state).toBe("running");
    expect(day.primary?.id).toBe(live.id);
    expect(day.upcoming.map((t) => t.id)).toEqual([later.id]);
    expect(day.deliveredStops).toBe(1);
  });

  it("a run that started YESTERDAY and is still open still owns Home", () => {
    // Scoping "running" to today's pickup date would blank Home just after
    // midnight, mid-run — the one moment the driver most needs it.
    const live = trip("in_progress", "2026-07-28T22:00:00+08:00", ["pending"]);
    const day = buildDriverDay([live], NOW);
    expect(day.state).toBe("running");
    expect(day.primary?.id).toBe(live.id);
  });

  it("one delivered + one still due → between", () => {
    const done = trip("pending_approval", "2026-07-29T08:00:00+08:00", ["delivered"]);
    const due = trip("assigned", "2026-07-29T13:30:00+08:00", ["pending"]);
    const day = buildDriverDay([done, due], NOW);
    expect(day.state).toBe("between");
    expect(day.primary?.id).toBe(due.id);
    expect(day.receipts.map((t) => t.id)).toEqual([done.id]);
  });

  it("everything delivered → finished, with every receipt kept", () => {
    const a = trip("pending_approval", "2026-07-29T08:00:00+08:00", ["delivered"]);
    const b = trip("completed", "2026-07-29T14:00:00+08:00", ["delivered", "delivered"]);
    const day = buildDriverDay([a, b], NOW);
    expect(day.state).toBe("finished");
    expect(day.receipts).toHaveLength(2);
    expect(day.deliveredStops).toBe(3);
    expect(day.stopCount).toBe(3);
  });

  it("an awaiting-approval trip counts as delivered work, not as pending work", () => {
    // pending_approval means the goods ARRIVED; only the pay is held. Treating
    // it as unfinished would tell the driver he still has a run to do.
    const day = buildDriverDay([trip("pending_approval", "2026-07-29T08:00:00+08:00", ["delivered"])], NOW);
    expect(day.state).toBe("finished");
  });

  it("empty today → surfaces the next assigned trip on a later day", () => {
    const tomorrow = trip("assigned", "2026-07-30T08:00:00+08:00", ["pending"]);
    const day = buildDriverDay([tomorrow], NOW);
    expect(day.state).toBe("no_trips");
    expect(day.nextLater?.id).toBe(tomorrow.id);
    // Tomorrow's work must not inflate today's counts.
    expect(day.tripCount).toBe(0);
    expect(day.stopCount).toBe(0);
  });

  it("nextLater stays null whenever today has work", () => {
    const today = trip("assigned", "2026-07-29T09:00:00+08:00");
    const tomorrow = trip("assigned", "2026-07-30T08:00:00+08:00");
    expect(buildDriverDay([today, tomorrow], NOW).nextLater).toBeNull();
  });

  it("cancelled and rejected trips are not today's work", () => {
    const day = buildDriverDay(
      [trip("cancelled", "2026-07-29T09:00:00+08:00"), trip("rejected", "2026-07-29T10:00:00+08:00")],
      NOW
    );
    expect(day.state).toBe("no_trips");
    expect(day.tripCount).toBe(0);
  });
});

describe("stop counters", () => {
  it("counts delivered against total", () => {
    expect(stopProgress(trip("in_progress", "2026-07-29T09:00:00+08:00", ["delivered", "pending", "pending"])))
      .toEqual({ delivered: 1, total: 3 });
  });

  it("current stop is the first UNDELIVERED one, not delivered+1", () => {
    // Stop order is a suggestion (Mr. Teh, 28 Jul 2026), so stop 2 can be
    // delivered before stop 1. "Stop 2 of 3" would then point at finished work.
    const t = trip("in_progress", "2026-07-29T09:00:00+08:00", ["pending", "delivered", "pending"]);
    expect(currentStopNumber(t)).toBe(1);
  });

  it("all delivered → the last stop, never total+1", () => {
    expect(currentStopNumber(trip("completed", "2026-07-29T09:00:00+08:00", ["delivered", "delivered"]))).toBe(2);
  });
});
