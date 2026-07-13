import { describe, expect, it } from "vitest";
import { byPickupUrgency } from "./pendingOrder";

const trip = (pickup: string, created: string) => ({
  pickup_datetime: pickup,
  created_at: created,
});

describe("pending column ordering", () => {
  it("puts the earliest pickup first regardless of creation order", () => {
    const justBooked = trip("2026-07-06T09:00:00Z", "2026-07-04T08:30:00Z");
    const waitingSinceDawn = trip("2026-07-04T02:00:00Z", "2026-07-04T05:00:00Z");
    const sorted = [justBooked, waitingSinceDawn].sort(byPickupUrgency);
    expect(sorted[0]).toBe(waitingSinceDawn);
  });

  it("breaks same-slot ties by oldest booking first (FIFO fairness)", () => {
    const later = trip("2026-07-04T02:00:00Z", "2026-07-04T01:59:00Z");
    const earlier = trip("2026-07-04T02:00:00Z", "2026-07-03T22:00:00Z");
    const sorted = [later, earlier].sort(byPickupUrgency);
    expect(sorted[0]).toBe(earlier);
  });
});
