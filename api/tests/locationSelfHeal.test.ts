import { describe, it, expect } from "vitest";
import { inactiveTripIds } from "../src/lib/locationSelfHeal";

// The background GPS task self-stops any trip the server reports as inactive.
describe("inactiveTripIds — what the phone must stop tracking", () => {
  it("an in_progress trip is active — not returned", () => {
    expect(inactiveTripIds([{ id: "t1", status: "in_progress" }])).toEqual([]);
  });

  it("returns every trip that has left in_progress", () => {
    const trips = [
      { id: "live", status: "in_progress" },
      { id: "done", status: "completed" },
      { id: "awaiting", status: "pending_approval" },
      { id: "killed", status: "cancelled" },
      { id: "unassigned", status: "assigned" }, // admin bounced it back
    ];
    expect(inactiveTripIds(trips).sort()).toEqual(
      ["awaiting", "done", "killed", "unassigned"].sort()
    );
  });

  it("empty in → empty out", () => {
    expect(inactiveTripIds([])).toEqual([]);
  });
});
