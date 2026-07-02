import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  assertStopDeliverable,
  finalizeTripOnce,
  type TripFinalizeClient,
} from "../src/services/tripCompletion";

/**
 * Guards that close the re-finalization pay hole: a driver re-posting
 * action=delivered (with an explicit stop_id) on a COMPLETED trip must never
 * re-run finalization — that would overwrite incentive_earned at the live
 * rates and current day ledger (e.g. RM44 Ipoh trip re-scored → RM66).
 */

function expectApiError(fn: () => void, code: string, statusCode: number) {
  try {
    fn();
    expect.unreachable(`expected ${code} to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    expect((err as ApiError).statusCode).toBe(statusCode);
  }
}

describe("assertStopDeliverable", () => {
  it("rejects delivery on a completed trip (re-finalization attempt)", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "completed" }, { status: "delivered" }),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects delivery on a trip that was never started (assigned)", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "assigned" }, { status: "pending" }),
      "TRIP_NOT_ACTIVE",
      409
    );
  });

  it("rejects re-delivering an already-delivered stop mid-trip", () => {
    expectApiError(
      () => assertStopDeliverable({ status: "in_progress" }, { status: "delivered" }),
      "STOP_ALREADY_DELIVERED",
      409
    );
  });

  it("allows delivering a pending or arrived stop on an in_progress trip", () => {
    expect(() =>
      assertStopDeliverable({ status: "in_progress" }, { status: "pending" })
    ).not.toThrow();
    expect(() =>
      assertStopDeliverable({ status: "in_progress" }, { status: "arrived" })
    ).not.toThrow();
  });
});

describe("finalizeTripOnce (write-once compare-and-set)", () => {
  // In-memory model of the status-guarded conditional update: the row only
  // matches while it is in_progress with no incentive written yet.
  function fakeTrip(initial: { status: string; incentive_earned: number | null }) {
    const row: { status: string; incentive_earned: number | null } = { ...initial };
    const client: TripFinalizeClient = {
      trip: {
        async updateMany({ data }) {
          if (row.status !== "in_progress" || row.incentive_earned !== null) {
            return { count: 0 };
          }
          row.status = data.status as string;
          row.incentive_earned = data.incentive_earned as number;
          return { count: 1 };
        },
      },
    };
    return { row, client };
  }

  it("finalizes an in_progress trip exactly once", async () => {
    const { row, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    expect(await finalizeTripOnce(client, "t1", 44)).toBe(true);
    expect(row).toEqual({ status: "completed", incentive_earned: 44 });
  });

  it("a second finalization loses and never overwrites the stored incentive", async () => {
    const { row, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await finalizeTripOnce(client, "t1", 44);
    // Re-delivery scenario: rates/day-ledger have changed, recompute says 66.
    expect(await finalizeTripOnce(client, "t1", 66)).toBe(false);
    expect(row.incentive_earned).toBe(44); // pay unchanged
  });

  it("never finalizes a trip that is not in_progress", async () => {
    const { row, client } = fakeTrip({ status: "completed", incentive_earned: 44 });
    expect(await finalizeTripOnce(client, "t1", 66)).toBe(false);
    expect(row.incentive_earned).toBe(44);
  });

  it("holiday-calendar edits never touch stored pay: a re-finalization at the new tier loses", async () => {
    // Weekday Ipoh trip finalized at RM44 with an empty calendar; an admin then
    // adds that date as a holiday. Recomputing WOULD give (6−2)×13 = RM52, but
    // the decision ran exactly once at finalization — the CAS refuses a rerun
    // and the stored pay stays RM44 (readers only ever sum the stored value).
    const { row, client } = fakeTrip({ status: "in_progress", incentive_earned: null });
    await finalizeTripOnce(client, "t1", 44);
    expect(await finalizeTripOnce(client, "t1", 52)).toBe(false);
    expect(row).toEqual({ status: "completed", incentive_earned: 44 });
  });
});
