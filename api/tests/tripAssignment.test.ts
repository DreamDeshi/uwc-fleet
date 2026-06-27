import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  claimPendingTrip,
  claimPendingTripOrThrow,
  type TripClaimClient,
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
