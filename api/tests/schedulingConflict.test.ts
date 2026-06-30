import { describe, it, expect } from "vitest";
import {
  findSchedulingConflicts,
  ASSIGNMENT_CONFLICT_BUFFER_MIN,
  type ConflictCandidateTrip,
} from "../src/services/schedulingConflict";

const BUFFER_MS = 120 * 60 * 1000; // 120 min, the default
const P = new Date("2026-06-22T06:00:00Z"); // 2:00pm MYT
const DRIVER = "driver-azmi";
const TRUCK = "PLX 2406";
const min = (n: number) => new Date(P.getTime() + n * 60 * 1000);

function candidate(over: Partial<ConflictCandidateTrip> = {}): ConflictCandidateTrip {
  return {
    id: "x1",
    status: "assigned",
    driver_id: DRIVER,
    truck_plate: TRUCK,
    pickup_datetime: min(60),
    driver: { name: "Driver 1" },
    ...over,
  };
}

const base = {
  newTripId: "N",
  driverId: DRIVER,
  truckPlate: TRUCK,
  pickupDateTime: P,
  bufferMs: BUFFER_MS,
};

describe("findSchedulingConflicts", () => {
  it("defaults the buffer to 120 minutes", () => {
    expect(ASSIGNMENT_CONFLICT_BUFFER_MIN).toBe(120);
  });

  it("flags a same-DRIVER trip within the buffer", () => {
    const c = findSchedulingConflicts({
      ...base,
      candidates: [candidate({ truck_plate: "OTHER 1", pickup_datetime: min(60) })],
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ tripId: "x1", driverOrTruck: "driver", plateOrDriverName: "Driver 1" });
  });

  it("flags a same-TRUCK trip within the buffer (different driver)", () => {
    const c = findSchedulingConflicts({
      ...base,
      candidates: [candidate({ driver_id: "driver-other", pickup_datetime: min(-90) })],
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ tripId: "x1", driverOrTruck: "truck", plateOrDriverName: TRUCK });
  });

  it("does NOT flag a trip outside the buffer (incl. exactly at the boundary)", () => {
    expect(
      findSchedulingConflicts({ ...base, candidates: [candidate({ pickup_datetime: min(121) })] })
    ).toHaveLength(0);
    // exactly 120 min away → |Δ| >= buffer → not a conflict
    expect(
      findSchedulingConflicts({ ...base, candidates: [candidate({ pickup_datetime: min(120) })] })
    ).toHaveLength(0);
  });

  it("does NOT flag completed / cancelled / rejected / pending trips", () => {
    for (const status of ["completed", "cancelled", "rejected", "pending"]) {
      expect(
        findSchedulingConflicts({ ...base, candidates: [candidate({ status })] })
      ).toHaveLength(0);
    }
  });

  it("does NOT flag a trip for a different driver AND different truck", () => {
    expect(
      findSchedulingConflicts({
        ...base,
        candidates: [candidate({ driver_id: "driver-other", truck_plate: "OTHER 1" })],
      })
    ).toHaveLength(0);
  });

  it("never flags the new trip itself", () => {
    expect(
      findSchedulingConflicts({ ...base, candidates: [candidate({ id: "N" })] })
    ).toHaveLength(0);
  });

  it("reports a driver+truck double-match once, labelled by driver", () => {
    const c = findSchedulingConflicts({ ...base, candidates: [candidate()] });
    expect(c).toHaveLength(1);
    expect(c[0].driverOrTruck).toBe("driver");
  });

  it("includes the conflicting trip's pickup as an ISO instant", () => {
    const c = findSchedulingConflicts({
      ...base,
      candidates: [candidate({ pickup_datetime: min(30) })],
    });
    expect(c[0].pickup).toBe(min(30).toISOString());
  });
});
