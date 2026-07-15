import { describe, it, expect } from "vitest";
import {
  claimPendingTrip,
  rejectPendingTrip,
  cancelBookedTrip,
  abortActiveTrip,
  outsourcePendingTrip,
  type TripExitClient,
  type TripClaimClient,
} from "../src/services/tripAssignment";

/**
 * CAS race guards on the trip EXITS — reject / cancel / assign-external
 * (money-path review, 4 Jul 2026). These were plain update-by-id behind a
 * pre-check; a collision with the 60s auto-dispatch sweep could stamp
 * rejected/cancelled/outsourced over a trip that had JUST been claimed with
 * an internal driver + frozen rate snapshot. Same status-guarded updateMany
 * discipline as claimPendingTrip / releaseAssignedTrip: the mutation applies
 * only while the trip is still in the expected status; the losing side gets
 * a clean false (409 TRIP_STATE_CHANGED at the route).
 */

// In-memory Trip row honouring the status-guarded updateMany CAS. Accepts both
// where shapes used across the primitives: status: "pending" (claim) and
// status: { in: [...] } (exits) — mirroring Postgres applying either filter
// atomically within the single UPDATE statement.
function fakeTripStore(initial: { status: string; [k: string]: unknown }) {
  const row: Record<string, unknown> = { id: "t1", driver_id: null, truck_plate: null, ...initial };
  const client = {
    trip: {
      async updateMany(args: {
        where: { id: string; status: string | { in: string[] } };
        data: Record<string, unknown>;
      }) {
        await Promise.resolve(); // racers line up here; the CAS below is atomic
        const allowed =
          typeof args.where.status === "string" ? [args.where.status] : args.where.status.in;
        if (row.id !== args.where.id || !allowed.includes(row.status as string)) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  };
  return { row, client: client as TripExitClient & TripClaimClient };
}

describe("rejectPendingTrip — status-guarded reject", () => {
  it("rejects a still-pending booking and records the reason", async () => {
    const { row, client } = fakeTripStore({ status: "pending", auto_dispatch_failed: true });
    expect(await rejectPendingTrip(client, "t1", "no truck available")).toBe(true);
    expect(row.status).toBe("rejected");
    expect(row.rejection_reason).toBe("no truck available");
    expect(row.auto_dispatch_failed).toBe(false); // self-clearing flag reset
  });

  it("loses cleanly when auto-dispatch already assigned the trip (no rejected-over-assigned)", async () => {
    const { row, client } = fakeTripStore({
      status: "assigned",
      driver_id: "d1",
      truck_plate: "PLX 2406",
    });
    expect(await rejectPendingTrip(client, "t1", null)).toBe(false);
    expect(row.status).toBe("assigned"); // the assignment survives untouched
    expect(row.driver_id).toBe("d1");
  });
});

describe("cancelBookedTrip — status-guarded cancel", () => {
  it("cancels a pending booking", async () => {
    const { row, client } = fakeTripStore({ status: "pending" });
    expect(await cancelBookedTrip(client, "t1")).toBe(true);
    expect(row.status).toBe("cancelled");
  });

  it("cancels an approved booking (same statuses the route pre-check allows)", async () => {
    const { row, client } = fakeTripStore({ status: "approved" });
    expect(await cancelBookedTrip(client, "t1")).toBe(true);
    expect(row.status).toBe("cancelled");
  });

  it("never cancels a trip that just went assigned — no cancelled trip with a driver attached", async () => {
    const { row, client } = fakeTripStore({
      status: "assigned",
      driver_id: "d1",
      truck_plate: "PLX 2406",
    });
    expect(await cancelBookedTrip(client, "t1")).toBe(false);
    expect(row.status).toBe("assigned");
  });

  it("never cancels an in_progress or completed trip", async () => {
    for (const status of ["in_progress", "completed"]) {
      const { row, client } = fakeTripStore({ status });
      expect(await cancelBookedTrip(client, "t1")).toBe(false);
      expect(row.status).toBe(status);
    }
  });
});

describe("abortActiveTrip — status-guarded admin de-orphan (in_progress only)", () => {
  it("aborts an in_progress trip → cancelled (frees the truck)", async () => {
    const { row, client } = fakeTripStore({ status: "in_progress", driver_id: "d1", truck_plate: "PLX 2406" });
    expect(await abortActiveTrip(client, "t1")).toBe(true);
    expect(row.status).toBe("cancelled");
    // Money fields are deliberately untouched — an abort never finalizes pay.
    expect(row.incentive_earned).toBeUndefined();
  });

  it("never aborts a trip that is not in_progress (pending/approved/assigned/completed/cancelled)", async () => {
    for (const status of ["pending", "approved", "assigned", "completed", "cancelled"]) {
      const { row, client } = fakeTripStore({ status });
      expect(await abortActiveTrip(client, "t1")).toBe(false);
      expect(row.status).toBe(status);
    }
  });

  it("loses cleanly to a trip that JUST completed — never cancels a finalized (paid) trip", async () => {
    // Model the last-stop delivery landing first: the row is already completed.
    const { row, client } = fakeTripStore({ status: "completed", incentive_earned: 55 });
    expect(await abortActiveTrip(client, "t1")).toBe(false);
    expect(row.status).toBe("completed");
    expect(row.incentive_earned).toBe(55); // pay survives untouched
  });
});

describe("outsourcePendingTrip — status-guarded assign-external", () => {
  it("outsources a still-pending booking (assigned + is_external)", async () => {
    const { row, client } = fakeTripStore({ status: "pending", is_external: false });
    expect(await outsourcePendingTrip(client, "t1")).toBe(true);
    expect(row.status).toBe("assigned");
    expect(row.is_external).toBe(true);
  });

  it("loses to a concurrent internal claim — no outsourced trip with an internal driver + frozen rates", async () => {
    const { row, client } = fakeTripStore({
      status: "assigned",
      driver_id: "d1",
      truck_plate: "PLX 2406",
      is_external: false,
      entitled_claim_weekday: 11,
    });
    expect(await outsourcePendingTrip(client, "t1")).toBe(false);
    // The internal assignment (and its rate snapshot) survives intact.
    expect(row.is_external).toBe(false);
    expect(row.driver_id).toBe("d1");
    expect(row.entitled_claim_weekday).toBe(11);
  });
});

describe("exit vs auto-dispatch claim — the race itself", () => {
  it("a concurrent cancel and internal claim: exactly one wins, the row stays consistent", async () => {
    const { row, client } = fakeTripStore({ status: "pending" });
    const [claimWon, cancelWon] = await Promise.all([
      claimPendingTrip(client, "t1", { driver_id: "d1", truck_plate: "PLX 2406" }),
      cancelBookedTrip(client, "t1"),
    ]);
    expect(claimWon !== cancelWon).toBe(true); // exactly one winner
    if (claimWon) {
      expect(row.status).toBe("assigned");
      expect(row.driver_id).toBe("d1");
    } else {
      expect(row.status).toBe("cancelled");
      expect(row.driver_id).toBeNull(); // never a cancelled trip with a driver
    }
  });

  it("a concurrent assign-external and internal claim: exactly one wins", async () => {
    const { row, client } = fakeTripStore({ status: "pending", is_external: false });
    const [claimWon, outsourceWon] = await Promise.all([
      claimPendingTrip(client, "t1", { driver_id: "d1", truck_plate: "PLX 2406" }),
      outsourcePendingTrip(client, "t1"),
    ]);
    expect(claimWon !== outsourceWon).toBe(true);
    // Whichever won, the trip is never both external AND internally driven.
    expect(row.is_external === true && row.driver_id !== null).toBe(false);
  });
});
