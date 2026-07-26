import { describe, expect, it } from "vitest";
import { odometerViolation } from "../src/lib/fuelOdometer";

// Interval-aware odometer plausibility (DG-M5): readings must be
// non-decreasing along the truck's TIMELINE, while backdated entries stay
// legal as long as they fit between their chronological neighbours.

const at = (iso: string) => new Date(iso);
const point = (odometer: number | null, iso: string) => ({ odometer, logged_at: at(iso) });

const HISTORY = [
  point(1000, "2026-07-20T08:00:00Z"),
  point(1200, "2026-07-22T08:00:00Z"),
  point(null, "2026-07-23T08:00:00Z"), // legacy row without a reading — ignored
  point(1500, "2026-07-25T08:00:00Z"),
];

describe("odometerViolation", () => {
  it("accepts a first-ever reading and a normal append", () => {
    expect(odometerViolation([], { odometer: 500, logged_at: at("2026-07-26T08:00:00Z") })).toBeNull();
    expect(
      odometerViolation(HISTORY, { odometer: 1600, logged_at: at("2026-07-26T08:00:00Z") })
    ).toBeNull();
  });

  it("rejects an append below the latest reading (the fat-finger case)", () => {
    expect(
      odometerViolation(HISTORY, { odometer: 1400, logged_at: at("2026-07-26T08:00:00Z") })
    ).toEqual({ neighborKm: 1500, neighbor: "earlier" });
  });

  it("accepts a backdated entry that fits between its neighbours", () => {
    expect(
      odometerViolation(HISTORY, { odometer: 1300, logged_at: at("2026-07-23T12:00:00Z") })
    ).toBeNull();
  });

  it("rejects a backdated entry that contradicts either neighbour", () => {
    // Below the 1200 logged before it…
    expect(
      odometerViolation(HISTORY, { odometer: 1100, logged_at: at("2026-07-23T12:00:00Z") })
    ).toEqual({ neighborKm: 1200, neighbor: "earlier" });
    // …or above the 1500 logged after it.
    expect(
      odometerViolation(HISTORY, { odometer: 1600, logged_at: at("2026-07-23T12:00:00Z") })
    ).toEqual({ neighborKm: 1500, neighbor: "later" });
  });

  it("treats an equal reading as valid (no distance driven between fills)", () => {
    expect(
      odometerViolation(HISTORY, { odometer: 1500, logged_at: at("2026-07-26T08:00:00Z") })
    ).toBeNull();
  });

  it("ignores legacy null-odometer rows entirely", () => {
    const onlyLegacy = [point(null, "2026-07-20T08:00:00Z")];
    expect(
      odometerViolation(onlyLegacy, { odometer: 10, logged_at: at("2026-07-26T08:00:00Z") })
    ).toBeNull();
  });
});
