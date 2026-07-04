import { describe, it, expect } from "vitest";
import {
  startAssignedTripForDriver,
  type TripStartClient,
} from "../src/services/tripAssignment";

/**
 * One-active-trip enforced at the START transition (money-path review,
 * 4 Jul 2026): a driver may HOLD several assigned trips (assign ≠ start — an
 * admin pre-assigning two is legitimate), but may be OUT on only one
 * in_progress trip. Before this guard the start action only checked the
 * trip's own status, so a driver holding two assigned trips could start both
 * — the exact double-in_progress state that double-pays the finalize
 * day-ledger (see dayLedger.test.ts for the RM88→RM55 money side).
 */

// In-memory multi-row Trip store. The guarded conditional update is ONE
// statement in Postgres, so the fake runs its check+write synchronously after
// a single await point — two racers can line up before the CAS but can never
// interleave inside it. (The truly-simultaneous-snapshot case is covered in
// production by Serializable isolation at the route, not modelled here.)
function makeStore(rows: Array<{ id: string; driver_id: string; status: string }>) {
  const store = rows.map((r) => ({ ...r }));
  const otherInProgress = (driverId: string, excludeId: string) =>
    store.some((r) => r.driver_id === driverId && r.status === "in_progress" && r.id !== excludeId);
  const client: TripStartClient = {
    trip: {
      async updateMany({ where }) {
        await Promise.resolve(); // racers line up here; the section below is atomic
        const row = store.find((r) => r.id === where.id);
        if (!row || row.status !== "assigned" || row.driver_id !== where.driver_id) {
          return { count: 0 };
        }
        if (otherInProgress(where.driver_id, where.id)) {
          return { count: 0 };
        }
        row.status = "in_progress";
        return { count: 1 };
      },
      async count({ where }) {
        return store.filter(
          (r) =>
            r.driver_id === where.driver_id &&
            r.status === "in_progress" &&
            r.id !== where.id.not
        ).length;
      },
    },
  };
  return { store, client };
}

describe("startAssignedTripForDriver — one-active-trip at start", () => {
  it("a driver already out on an in_progress trip cannot start a second", async () => {
    const { store, client } = makeStore([
      { id: "tA", driver_id: "d1", status: "in_progress" },
      { id: "tB", driver_id: "d1", status: "assigned" },
    ]);
    expect(await startAssignedTripForDriver(client, "tB", "d1")).toBe("driver_busy");
    expect(store.find((r) => r.id === "tB")!.status).toBe("assigned"); // untouched
  });

  it("a driver HOLDING several assigned trips can start one (assign ≠ start)", async () => {
    const { store, client } = makeStore([
      { id: "tA", driver_id: "d1", status: "assigned" },
      { id: "tB", driver_id: "d1", status: "assigned" },
    ]);
    expect(await startAssignedTripForDriver(client, "tA", "d1")).toBe("started");
    expect(store.find((r) => r.id === "tA")!.status).toBe("in_progress");
    expect(store.find((r) => r.id === "tB")!.status).toBe("assigned"); // still held, not started
  });

  it("another driver's in_progress trip does not block this driver", async () => {
    const { client } = makeStore([
      { id: "tA", driver_id: "d2", status: "in_progress" },
      { id: "tB", driver_id: "d1", status: "assigned" },
    ]);
    expect(await startAssignedTripForDriver(client, "tB", "d1")).toBe("started");
  });

  it("a trip that already left `assigned` reports state_changed (not driver_busy)", async () => {
    // e.g. an admin unassigned it back to pending a moment ago.
    const { client } = makeStore([{ id: "tA", driver_id: "d1", status: "pending" }]);
    expect(await startAssignedTripForDriver(client, "tA", "d1")).toBe("state_changed");
  });

  it("CONCURRENT double-start of two assigned trips: exactly one succeeds", async () => {
    const { store, client } = makeStore([
      { id: "tA", driver_id: "d1", status: "assigned" },
      { id: "tB", driver_id: "d1", status: "assigned" },
    ]);
    const outcomes = await Promise.all([
      startAssignedTripForDriver(client, "tA", "d1"),
      startAssignedTripForDriver(client, "tB", "d1"),
    ]);
    expect([...outcomes].sort()).toEqual(["driver_busy", "started"]);
    // The invariant, not just the return values: exactly one in_progress trip.
    expect(store.filter((r) => r.status === "in_progress")).toHaveLength(1);
  });

  it("CONCURRENT duplicate start of the SAME trip: one starts, the other sees state_changed", async () => {
    const { store, client } = makeStore([{ id: "tA", driver_id: "d1", status: "assigned" }]);
    const outcomes = await Promise.all([
      startAssignedTripForDriver(client, "tA", "d1"),
      startAssignedTripForDriver(client, "tA", "d1"),
    ]);
    // The loser's CAS fails on the trip's own status; the busy probe excludes
    // the trip itself, so the duplicate is reported as a state change, and the
    // trip is started exactly once (one audit row / timeline event).
    expect([...outcomes].sort()).toEqual(["started", "state_changed"]);
    expect(store.filter((r) => r.status === "in_progress")).toHaveLength(1);
  });
});
