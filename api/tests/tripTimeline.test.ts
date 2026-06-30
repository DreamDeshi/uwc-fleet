import { describe, it, expect } from "vitest";
import {
  buildTripTimeline,
  type TimelineTripInput,
  type TimelineStopInput,
} from "../src/lib/tripTimeline";

// ── Builders ───────────────────────────────────────────────────────────
const D = (s: string) => new Date(s);

function stop(over: Partial<TimelineStopInput> = {}): TimelineStopInput {
  return {
    id: over.id ?? "stop1",
    sequence: over.sequence ?? 1,
    status: over.status ?? "pending",
    arrived_at: over.arrived_at ?? null,
    delivered_at: over.delivered_at ?? null,
    consignee: over.consignee ?? { company_name: "ACME SDN BHD", area: "Kulim", zone_code: "K1" },
  };
}

function trip(over: Partial<TimelineTripInput> = {}): TimelineTripInput {
  return {
    status: over.status ?? "pending",
    created_at: over.created_at ?? D("2026-06-30T08:00:00Z"),
    is_external: over.is_external ?? false,
    rejection_reason: over.rejection_reason ?? null,
    driver: over.driver ?? null,
    truck_plate: over.truck_plate ?? null,
    stops: over.stops ?? [stop()],
    status_history: over.status_history ?? [],
  };
}

const eventsOf = (t: TimelineTripInput) => buildTripTimeline(t).map((s) => s.event);
const byEvent = (t: TimelineTripInput, ev: string) =>
  buildTripTimeline(t).filter((s) => s.event === ev);

describe("buildTripTimeline — happy path", () => {
  it("a pending single-stop trip shows Booked(done) → Assigned(current) → … → Completed(upcoming)", () => {
    const steps = buildTripTimeline(trip({ status: "pending" }));
    expect(steps.map((s) => s.event)).toEqual([
      "booked",
      "assigned",
      "started",
      "stop_arrived",
      "stop_delivered",
      "completed",
    ]);
    expect(steps[0].state).toBe("done");
    expect(steps[1].state).toBe("current"); // next actionable milestone
    expect(steps.slice(2).every((s) => s.state === "upcoming")).toBe(true);
  });

  it("marks every milestone done for a completed trip", () => {
    const steps = buildTripTimeline(
      trip({
        status: "completed",
        driver: { name: "Azmi" },
        truck_plate: "PLX 2406",
        stops: [
          stop({
            status: "delivered",
            arrived_at: D("2026-06-30T10:00:00Z"),
            delivered_at: D("2026-06-30T10:20:00Z"),
          }),
        ],
      })
    );
    expect(steps.every((s) => s.state === "done")).toBe(true);
    // Completed timestamp falls back to the last stop's delivery time.
    expect(steps.find((s) => s.event === "completed")!.timestamp).toBe(
      D("2026-06-30T10:20:00Z").toISOString()
    );
  });

  it("emits an Arrived+Delivered pair per stop for a multi-stop trip, in sequence", () => {
    const steps = buildTripTimeline(
      trip({
        status: "in_progress",
        stops: [
          stop({ id: "s1", sequence: 1, status: "delivered", arrived_at: D("2026-06-30T10:00:00Z"), delivered_at: D("2026-06-30T10:10:00Z"), consignee: { company_name: "A", area: "Kulim", zone_code: "K1" } }),
          stop({ id: "s2", sequence: 2, status: "arrived", arrived_at: D("2026-06-30T11:00:00Z"), consignee: { company_name: "B", area: "Ipoh", zone_code: "A2" } }),
        ],
      })
    );
    const stopSteps = steps.filter((s) => s.stopId);
    expect(stopSteps.map((s) => [s.stopId, s.event])).toEqual([
      ["s1", "stop_arrived"],
      ["s1", "stop_delivered"],
      ["s2", "stop_arrived"],
      ["s2", "stop_delivered"],
    ]);
    // s1 fully done; s2 arrived but not yet delivered (the current step).
    expect(stopSteps[0].state).toBe("done");
    expect(stopSteps[1].state).toBe("done");
    expect(stopSteps[2].state).toBe("done");
    expect(stopSteps[3].state).toBe("current");
    expect(stopSteps[0].stopLabel).toBe("Kulim");
  });
});

describe("buildTripTimeline — history rows are authoritative", () => {
  it("prefers a history timestamp/note over derived fallbacks", () => {
    const steps = buildTripTimeline(
      trip({
        status: "assigned",
        driver: { name: "Azmi" },
        truck_plate: "PLX 2406",
        status_history: [
          { event: "booked", stop_id: null, note: null, created_at: D("2026-06-30T07:55:00Z") },
          { event: "assigned", stop_id: null, note: "Azmi · PLX 2406", created_at: D("2026-06-30T08:30:00Z") },
        ],
      })
    );
    const booked = steps.find((s) => s.event === "booked")!;
    const assigned = steps.find((s) => s.event === "assigned")!;
    expect(booked.timestamp).toBe(D("2026-06-30T07:55:00Z").toISOString()); // not created_at
    expect(assigned.note).toBe("Azmi · PLX 2406");
    expect(assigned.state).toBe("done");
  });

  it("falls back to created_at for Booked and to the driver·plate for the assign note when no history exists", () => {
    const steps = buildTripTimeline(
      trip({ status: "assigned", driver: { name: "Shahar" }, truck_plate: "PND 1888" })
    );
    expect(steps.find((s) => s.event === "booked")!.timestamp).toBe(
      D("2026-06-30T08:00:00Z").toISOString()
    );
    expect(steps.find((s) => s.event === "assigned")!.note).toBe("Shahar · PND 1888");
  });
});

describe("buildTripTimeline — terminal branches", () => {
  it("Rejected: Booked → Rejected only, carrying the reason", () => {
    const t = trip({ status: "rejected", rejection_reason: "No capacity today" });
    expect(eventsOf(t)).toEqual(["booked", "rejected"]);
    expect(byEvent(t, "rejected")[0].note).toBe("No capacity today");
  });

  it("Cancelled: ends at Cancelled, never shows En route / stops / Completed", () => {
    const t = trip({ status: "cancelled" });
    const events = eventsOf(t);
    expect(events).toContain("cancelled");
    expect(events).not.toContain("started");
    expect(events).not.toContain("completed");
    expect(events).not.toContain("stop_arrived");
  });

  it("External forwarder: Booked → Assigned-external only", () => {
    const t = trip({ status: "assigned", is_external: true });
    expect(eventsOf(t)).toEqual(["booked", "assigned_external"]);
    expect(eventsOf(t)).not.toContain("started");
  });
});
