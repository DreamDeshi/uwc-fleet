import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  claimPendingTrip,
  claimPendingTripOrThrow,
  claimUnpausedPendingTrip,
  type TripClaimClient,
  type TripAutoClaimClient,
} from "../src/services/tripAssignment";

// In-memory stand-in for Postgres' atomic, status-guarded updateMany. The
// compare-and-set (read status, then write) runs synchronously after a single
// await point, so two "simultaneous" callers can't interleave between the check
// and the write — exactly the guarantee the real conditional update gives us
// (and, in production, Serializable isolation on top for cross-row conflicts).
function makeClient(initialStatus = "pending") {
  const trip = { status: initialStatus };
  const client: TripClaimClient = {
    trip: {
      async updateMany({ where, data }) {
        await Promise.resolve(); // yield so both racers reach the CAS together
        if (trip.status !== where.status) return { count: 0 };
        trip.status = String(data.status);
        return { count: 1 };
      },
    },
  };
  return { client, trip };
}

describe("claimPendingTrip", () => {
  it("wins once, then loses because the trip is no longer pending", async () => {
    const { client } = makeClient();
    expect(await claimPendingTrip(client, "t1", { driver_id: "d1", truck_plate: "T1" })).toBe(true);
    expect(await claimPendingTrip(client, "t1", { driver_id: "d2", truck_plate: "T1" })).toBe(false);
  });

  it("loses immediately when the trip starts non-pending", async () => {
    const { client } = makeClient("assigned");
    expect(await claimPendingTrip(client, "t1", { driver_id: "d1", truck_plate: "T1" })).toBe(false);
  });
});

// A pause-aware in-memory CAS: models BOTH the status guard and (when the
// predicate includes it) the auto_dispatch_paused guard, and records the exact
// `where` each claim issued. Untyped so it can back BOTH the manual claim (where
// omits the pin) and the automatic claim (where requires the pin clear).
function makeHoldAwareClient(initial: { status?: string; auto_dispatch_paused?: boolean } = {}) {
  const trip = { status: initial.status ?? "pending", auto_dispatch_paused: initial.auto_dispatch_paused ?? false };
  const wheres: Record<string, unknown>[] = [];
  const client = {
    trip: {
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        await Promise.resolve(); // yield so a "concurrent" hold can be set before the CAS resolves
        wheres.push(where);
        if (where.status !== undefined && trip.status !== where.status) return { count: 0 };
        if (where.auto_dispatch_paused !== undefined && trip.auto_dispatch_paused !== where.auto_dispatch_paused) {
          return { count: 0 };
        }
        if (data.status !== undefined) trip.status = String(data.status);
        if (data.auto_dispatch_paused !== undefined) trip.auto_dispatch_paused = Boolean(data.auto_dispatch_paused);
        return { count: 1 };
      },
    },
  };
  return { client, trip, wheres };
}

describe("claimUnpausedPendingTrip — the ATOMIC automatic-dispatch claim", () => {
  it("its CAS predicate requires id + status:pending + auto_dispatch_paused:false", async () => {
    const { client, wheres } = makeHoldAwareClient();
    await claimUnpausedPendingTrip(client as unknown as TripAutoClaimClient, "t1", { driver_id: "d1", truck_plate: "T1" });
    expect(wheres[0]).toEqual({ id: "t1", status: "pending", auto_dispatch_paused: false });
  });

  it("wins on a clear pending trip and clears the pin", async () => {
    const { client, trip } = makeHoldAwareClient({ status: "pending", auto_dispatch_paused: false });
    expect(await claimUnpausedPendingTrip(client as unknown as TripAutoClaimClient, "t1", { driver_id: "d1" })).toBe(true);
    expect(trip.status).toBe("assigned");
    expect(trip.auto_dispatch_paused).toBe(false);
  });

  it("HOLD-RACE: a pin set true AFTER preflight makes the claim lose and PRESERVES the hold", async () => {
    // Model the exact race: preflight saw paused=false, then an admin unassigns
    // (sets the pin) before the engine's claim resolves.
    const { client, trip } = makeHoldAwareClient({ status: "pending", auto_dispatch_paused: false });
    trip.auto_dispatch_paused = true; // the hold flips between preflight and claim
    const won = await claimUnpausedPendingTrip(client as unknown as TripAutoClaimClient, "t1", {
      driver_id: "d1",
      truck_plate: "T1",
    });
    expect(won).toBe(false); // lost the CAS → auto-dispatch stops safely
    expect(trip.status).toBe("pending"); // never assigned
    expect(trip.auto_dispatch_paused).toBe(true); // hold preserved, not cleared
  });

  it("also loses when the trip is already non-pending (status race unchanged)", async () => {
    const { client } = makeHoldAwareClient({ status: "assigned", auto_dispatch_paused: false });
    expect(await claimUnpausedPendingTrip(client as unknown as TripAutoClaimClient, "t1", { driver_id: "d1" })).toBe(false);
  });
});

describe("manual claim (claimPendingTrip) remains the explicit override", () => {
  it("its predicate does NOT include the pin — it claims a PAUSED pending ticket and clears the pin", async () => {
    const { client, trip, wheres } = makeHoldAwareClient({ status: "pending", auto_dispatch_paused: true });
    expect(await claimPendingTrip(client as unknown as TripClaimClient, "t1", { driver_id: "d1", truck_plate: "T1" })).toBe(true);
    // Manual predicate is pin-agnostic…
    expect("auto_dispatch_paused" in wheres[0]).toBe(false);
    // …and a successful manual assignment clears the hold.
    expect(trip.status).toBe("assigned");
    expect(trip.auto_dispatch_paused).toBe(false);
  });
});

describe("two simultaneous approvals race for the same trip", () => {
  it("exactly one wins and the other gets 409 CONCURRENT_ASSIGNMENT", async () => {
    const { client } = makeClient();

    const settled = await Promise.allSettled([
      claimPendingTripOrThrow(client, "t1", { driver_id: "driverA", truck_plate: "PLX 2406" }),
      claimPendingTripOrThrow(client, "t1", { driver_id: "driverB", truck_plate: "PND 1888" }),
    ]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONCURRENT_ASSIGNMENT");
  });
});
