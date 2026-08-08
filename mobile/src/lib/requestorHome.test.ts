import { describe, it, expect } from "vitest";
import { homeStatusStrip, nextBooking, requestorHome } from "./requestorHome";
import type { Trip, TripStatus } from "../types";

// A Wednesday, 12 August 2026, 09:00 local.
const NOW = new Date(2026, 7, 12, 9, 0, 0, 0);
const at = (d: number, h = 10, m = 0) => new Date(2026, 7, d, h, m, 0, 0);

let seq = 0;
function trip(pickup: Date, status: TripStatus): Trip {
  seq += 1;
  return {
    id: `t${seq}`,
    ticket_number: `TKT-${seq}`,
    status,
    pickup_datetime: pickup.toISOString(),
    created_at: pickup.toISOString(),
  } as unknown as Trip;
}

describe("nextBooking — the one booking the hero card shows", () => {
  it("is the earliest active pickup", () => {
    const later = trip(at(14), "assigned");
    const sooner = trip(at(12, 15), "pending");
    expect(nextBooking([later, sooner], NOW)?.id).toBe(sooner.id);
  });

  it("prefers a truck already ON THE ROAD over a sooner-scheduled booking", () => {
    // That is the booking whose driver the requestor might need to call.
    const running = trip(at(11), "in_progress");
    const sooner = trip(at(12, 10), "pending");
    expect(nextBooking([sooner, running], NOW)?.id).toBe(running.id);
  });

  it("still surfaces a booking whose pickup has slipped into the past", () => {
    // Hiding it behind "no upcoming bookings" is exactly wrong — a late pickup
    // is the one a requestor most wants to see.
    const late = trip(at(12, 7), "assigned");
    expect(nextBooking([late], NOW)?.id).toBe(late.id);
  });

  it("ignores finished and dead bookings", () => {
    const finished = [
      trip(at(12), "completed"),
      trip(at(12), "pending_approval"),
      trip(at(12), "cancelled"),
      trip(at(12), "rejected"),
    ];
    expect(nextBooking(finished, NOW)).toBeNull();
    expect(nextBooking([], NOW)).toBeNull();
  });
});

describe("requestorHome", () => {
  it("counts today's and this month's bookings by pickup date", () => {
    const trips = [
      trip(at(12, 8), "completed"),
      trip(at(12, 16), "assigned"),
      trip(at(20), "pending"),
      trip(new Date(2026, 6, 30), "completed"), // last month
    ];
    const home = requestorHome(trips, NOW);
    expect(home.todayCount).toBe(2);
    expect(home.monthCount).toBe(3);
  });

  it("lists finished bookings newest first, capped", () => {
    const trips = [
      trip(at(2), "completed"),
      trip(at(8), "cancelled"),
      trip(at(5), "rejected"),
      trip(at(11), "pending_approval"),
      trip(at(1), "completed"),
      trip(at(20), "pending"), // still active — not activity
    ];
    const home = requestorHome(trips, NOW, 3);
    expect(home.recent.map((tr) => tr.pickup_datetime)).toEqual([
      at(11).toISOString(),
      at(8).toISOString(),
      at(5).toISOString(),
    ]);
  });

  it("separates 'never booked' (frame 10b) from 'nothing upcoming'", () => {
    // A returning requestor with only past trips must NOT get the first-run
    // empty state — they still have activity worth showing.
    expect(requestorHome([], NOW).hasEverBooked).toBe(false);
    const returning = requestorHome([trip(at(2), "completed")], NOW);
    expect(returning.hasEverBooked).toBe(true);
    expect(returning.next).toBeNull();
    expect(returning.recent).toHaveLength(1);
  });
});

describe("homeStatusStrip", () => {
  it("counts down to an assigned pickup in hours, then minutes", () => {
    expect(homeStatusStrip(trip(at(12, 11), "assigned"), NOW)).toEqual({
      key: "requestor.stripAssignedHours",
      hours: 2,
    });
    expect(homeStatusStrip(trip(at(12, 9, 40), "assigned"), NOW)).toEqual({
      key: "requestor.stripAssignedMinutes",
      minutes: 40,
    });
  });

  it("drops the countdown once the pickup is past or far away", () => {
    expect(homeStatusStrip(trip(at(12, 7), "assigned"), NOW)?.key).toBe("requestor.stripAssigned");
    expect(homeStatusStrip(trip(at(20), "assigned"), NOW)?.key).toBe("requestor.stripAssigned");
  });

  it("says the truck is moving once it is", () => {
    expect(homeStatusStrip(trip(at(12, 8), "in_progress"), NOW)?.key).toBe(
      "requestor.stripOnTheWay"
    );
  });

  it("stays silent when there is no news — a pending booking has none", () => {
    expect(homeStatusStrip(trip(at(14), "pending"), NOW)).toBeNull();
    expect(homeStatusStrip(null, NOW)).toBeNull();
  });
});
