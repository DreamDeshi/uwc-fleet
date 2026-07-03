import { describe, it, expect } from "vitest";
import {
  claimPendingTrip,
  releaseAssignedTrip,
  RELEASE_TRIP_DATA,
} from "../src/services/tripAssignment";
import { truckRateSnapshot } from "../src/services/rateSnapshot";
import { effectiveTruckRates } from "../src/services/pendingRates";
import { assignedLeaveCollisions } from "../src/services/driverLeave";
import { mytDateKey } from "../src/services/incentiveEngine";
import { buildTripTimeline } from "../src/lib/tripTimeline";

// Admin unassign/reassign lever (client Q3, 3 Jul 2026): an ASSIGNED (not
// started) trip can be pulled back to pending or moved to another driver.
// These tests pin the atomic release primitive, the leave-collision rule and
// the timeline behaviour; the reassign route reuses the SAME assignTripInTx
// guard ladder as the approve route (single shared function), whose guards
// are covered by their own suites (truckEligibility, schedulingConflict,
// operatingWindow, driverLeave, tripAssignment, pallets).

// In-memory Trip store honouring the status-guarded updateMany CAS that both
// claimPendingTrip and releaseAssignedTrip rely on.
function fakeTripStore(initial: { id: string; status: string; [k: string]: unknown }) {
  const row: Record<string, unknown> = { ...initial };
  return {
    row,
    client: {
      trip: {
        async updateMany(args: {
          where: { id: string; status: string };
          data: Record<string, unknown>;
        }) {
          if (row.id !== args.where.id || row.status !== args.where.status) {
            return { count: 0 };
          }
          Object.assign(row, args.data);
          return { count: 1 };
        },
      },
    },
  };
}

const ASSIGNED_TRIP = {
  id: "t1",
  status: "assigned",
  driver_id: "d-old",
  truck_plate: "PLX 2406",
  entitled_claim_weekday: 11,
  entitled_claim_offpeak: 13,
  daily_deduction_points: 2,
  pending_alert_sent: true,
  auto_dispatch_failed: false,
};

describe("releaseAssignedTrip — the unassign primitive (CLIENT CASE: back to pending)", () => {
  it("returns an assigned trip to pending, frees the driver/truck and drops the rate snapshot", async () => {
    const { row, client } = fakeTripStore({ ...ASSIGNED_TRIP });
    const released = await releaseAssignedTrip(client, "t1");

    expect(released).toBe(true);
    expect(row.status).toBe("pending"); // re-enters the dispatch flow
    expect(row.driver_id).toBeNull(); // old driver freed
    expect(row.truck_plate).toBeNull();
    // The OLD truck's assignment-time snapshot must not survive the release —
    // the next assignment re-takes it for ITS truck.
    expect(row.entitled_claim_weekday).toBeNull();
    expect(row.entitled_claim_offpeak).toBeNull();
    expect(row.daily_deduction_points).toBeNull();
    // Flags reset: the pending sweep re-alerts (and auto-retries) if it sits;
    // no stale needs-attention state carried back in.
    expect(row.pending_alert_sent).toBe(false);
    expect(row.auto_dispatch_failed).toBe(false);
  });

  it("never releases an in_progress trip (driver already started — out of scope)", async () => {
    const { row, client } = fakeTripStore({ ...ASSIGNED_TRIP, status: "in_progress" });
    const released = await releaseAssignedTrip(client, "t1");
    expect(released).toBe(false);
    expect(row.status).toBe("in_progress");
    expect(row.driver_id).toBe("d-old"); // untouched
  });

  it("loses cleanly when the trip is not assigned (pending/completed/etc.)", async () => {
    for (const status of ["pending", "completed", "cancelled", "rejected"]) {
      const { client } = fakeTripStore({ ...ASSIGNED_TRIP, status });
      expect(await releaseAssignedTrip(client, "t1")).toBe(false);
    }
  });

  it("RELEASE_TRIP_DATA clears exactly the assignment-scoped fields", () => {
    expect(RELEASE_TRIP_DATA).toEqual({
      status: "pending",
      driver_id: null,
      truck_plate: null,
      entitled_claim_weekday: null,
      entitled_claim_offpeak: null,
      daily_deduction_points: null,
      pending_alert_sent: false,
      auto_dispatch_failed: false,
    });
  });
});

describe("release + re-claim — CLIENT CASE: reassign re-snapshots the NEW truck's rate", () => {
  it("the reassigned trip carries the new truck's (effective) rates, not the old snapshot", async () => {
    const { row, client } = fakeTripStore({ ...ASSIGNED_TRIP });

    // Step 1 — release (same tx in the real route).
    expect(await releaseAssignedTrip(client, "t1")).toBe(true);

    // Step 2 — claim for the new driver+truck, snapshotting the new truck's
    // rates effective NOW (Item 2's next-day cutoff applies here too).
    const newTruck = {
      entitled_claim_weekday: 9,
      entitled_claim_offpeak: 9,
      daily_deduction_points: 2,
      pending_claim_weekday: null,
      pending_claim_offpeak: null,
      pending_deduction_points: null,
      pending_rates_effective: null,
    };
    const claimed = await claimPendingTrip(client, "t1", {
      driver_id: "d-new",
      truck_plate: "PRH 5292",
      auto_dispatch_failed: false,
      ...truckRateSnapshot(effectiveTruckRates(newTruck, new Date("2026-07-03T04:00:00Z"))),
    });

    expect(claimed).toBe(true);
    expect(row.status).toBe("assigned");
    expect(row.driver_id).toBe("d-new");
    expect(row.truck_plate).toBe("PRH 5292");
    expect(row.entitled_claim_weekday).toBe(9); // NEW truck's rate, not PLX's 11
    expect(row.entitled_claim_offpeak).toBe(9);
    expect(row.daily_deduction_points).toBe(2);
  });

  it("a concurrent Start Trip beats the release — the reassign transaction aborts", async () => {
    const { client } = fakeTripStore({ ...ASSIGNED_TRIP, status: "in_progress" });
    expect(await releaseAssignedTrip(client, "t1")).toBe(false);
    // The route throws TRIP_NOT_UNASSIGNABLE and rolls the whole tx back.
  });
});

describe("assignedLeaveCollisions — leave-collision attention flag (CLIENT CASE)", () => {
  // Leave 2026-07-06 to 2026-07-08 (MYT).
  const leave = { start_date: "2026-07-06", end_date: "2026-07-08" };
  const tripOn = (isoUtc: string, status = "assigned") => ({
    status,
    pickup_datetime: new Date(isoUtc),
  });

  it("flags assigned trips whose pickup MYT day falls inside the leave range", () => {
    const inside = tripOn("2026-07-06T01:00:00Z"); // 2026-07-06 09:00 MYT
    const lastDay = tripOn("2026-07-08T09:00:00Z"); // 2026-07-08 17:00 MYT
    const before = tripOn("2026-07-05T08:00:00Z"); // 2026-07-05 16:00 MYT
    const after = tripOn("2026-07-09T01:00:00Z"); // 2026-07-09 09:00 MYT
    const hits = assignedLeaveCollisions([inside, lastDay, before, after], leave, mytDateKey);
    expect(hits).toEqual([inside, lastDay]);
  });

  it("compares in MYT: a UTC instant late on the 5th is already the 6th in MYT", () => {
    const mytSixth = tripOn("2026-07-05T17:00:00Z"); // 2026-07-06 01:00 MYT → collides
    expect(assignedLeaveCollisions([mytSixth], leave, mytDateKey)).toEqual([mytSixth]);
  });

  it("only ASSIGNED trips collide — pending has no driver, in_progress is already out", () => {
    const trips = [
      tripOn("2026-07-06T01:00:00Z", "pending"),
      tripOn("2026-07-06T01:00:00Z", "in_progress"),
      tripOn("2026-07-06T01:00:00Z", "completed"),
    ];
    expect(assignedLeaveCollisions(trips, leave, mytDateKey)).toEqual([]);
  });
});

describe("timeline — unassign/reassign milestones", () => {
  const baseTrip = {
    created_at: new Date("2026-07-01T01:00:00Z"),
    is_external: false,
    rejection_reason: null,
    stops: [],
    status_history: [] as { event: string; stop_id: string | null; note: string | null; created_at: Date }[],
  };
  const h = (event: string, note: string | null, minute: number) => ({
    event: event as never,
    stop_id: null,
    note,
    created_at: new Date(`2026-07-01T02:${String(minute).padStart(2, "0")}:00Z`),
  });

  it("an unassigned-back-to-pending trip shows Assigned as upcoming again (no stale note)", () => {
    const steps = buildTripTimeline({
      ...baseTrip,
      status: "pending",
      driver: null,
      truck_plate: null,
      status_history: [h("booked", null, 0), h("assigned", "Driver A · PLX 2406", 1), h("unassigned", "was Driver A · PLX 2406", 2)],
    } as never);
    const assigned = steps.find((s) => s.event === "assigned")!;
    expect(assigned.state).not.toBe("done");
    expect(assigned.timestamp).toBeNull();
  });

  it("a reassigned trip's Assigned milestone carries the LATEST assignment note", () => {
    const steps = buildTripTimeline({
      ...baseTrip,
      status: "assigned",
      driver: { name: "Driver B" },
      truck_plate: "PRH 5292",
      status_history: [
        h("booked", null, 0),
        h("assigned", "Driver A · PLX 2406", 1),
        h("reassigned", "Driver A · PLX 2406 → Driver B · PRH 5292", 2),
      ],
    } as never);
    const assigned = steps.find((s) => s.event === "assigned")!;
    expect(assigned.state).toBe("done");
    expect(assigned.note).toContain("Driver B");
    expect(assigned.timestamp).toBe("2026-07-01T02:02:00.000Z"); // the reassign moment
  });

  it("a plain assigned trip is unchanged (regression guard)", () => {
    const steps = buildTripTimeline({
      ...baseTrip,
      status: "assigned",
      driver: { name: "Driver A" },
      truck_plate: "PLX 2406",
      status_history: [h("booked", null, 0), h("assigned", "Driver A · PLX 2406", 1)],
    } as never);
    const assigned = steps.find((s) => s.event === "assigned")!;
    expect(assigned.state).toBe("done");
    expect(assigned.note).toBe("Driver A · PLX 2406");
  });
});
