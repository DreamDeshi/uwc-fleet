import { describe, it, expect } from "vitest";
import {
  selectTruck,
  enRouteZones,
  autoAssignNote,
  autoDispatchFailureNote,
  autoDispatchBlockReason,
  type TruckCandidate,
} from "../src/services/dispatchEngine";
import { estimateOperatingWindow } from "../src/services/operatingWindow";

// Adjacency from the seed (Mr. Teh's email): P2↔K1, P2↔A1. KL is the newer
// long-haul zone — out of the adjacency matrix (no neighbours), same as the
// seed's ZONE_ADJACENCY, so an order there falls back to "any free truck".
const ADJACENCY: Record<string, string[]> = {
  P1: [],
  P2: ["K1", "A1"],
  P3: [],
  K1: ["P2"],
  K2: [],
  A1: ["P2"],
  A2: [],
  KL: [],
};

// Real fleet capacities (Brief Section 2).
function truck(over: Partial<TruckCandidate> & { plate: string; maxPallets: number }): TruckCandidate {
  return {
    driverId: `drv-${over.plate}`,
    currentLoad: 0,
    coverageZones: [],
    activeZones: [],
    ...over,
  };
}

describe("selectTruck — Best-Fit Decreasing (Rule A)", () => {
  it("picks the smallest truck that fits so big trucks stay free", () => {
    const candidates = [
      truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["K1"] }),
      truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["K1"] }),
      truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["K1"] }),
    ];
    const sel = selectTruck({ pallets: 5, zone: "K1" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PRJ 5292"); // 2 too small, 8 is smallest that fits 5
  });

  it("returns null when no truck can fit the order (hard overload prevention)", () => {
    const candidates = [
      truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["P2"] }),
      truck({ plate: "4 Wheel", maxPallets: 2, coverageZones: ["P2"] }),
    ];
    expect(selectTruck({ pallets: 5, zone: "P2" }, candidates, ADJACENCY)).toBeNull();
  });

  it("never exceeds max_pallets even by one", () => {
    const candidates = [truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["K1"] })];
    expect(selectTruck({ pallets: 8, zone: "K1" }, candidates, ADJACENCY)?.plate).toBe("PRJ 5292");
    expect(selectTruck({ pallets: 9, zone: "K1" }, candidates, ADJACENCY)).toBeNull();
  });
});

describe("selectTruck — driver priority zones", () => {
  it("prefers a driver whose coverage includes the order zone over one who doesn't", () => {
    // K2 order (not A1/A2, so no primary lock interferes): the 14-pallet
    // coverer beats the smaller non-coverer — coverage outranks size.
    const candidates = [
      truck({ plate: "PQL 5292", maxPallets: 8, coverageZones: ["P3"] }),
      truck({ plate: "PSA 5292", maxPallets: 14, coverageZones: ["P1", "P2", "P3", "K1", "K2"] }),
    ];
    const sel = selectTruck({ pallets: 6, zone: "K2" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PSA 5292");
  });

  it("falls back to an adjacent-zone driver when no driver covers the zone", () => {
    // No K1-coverage driver free; a P2 driver is adjacent to K1.
    const candidates = [
      truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["P2"] }), // P2 adjacent to K1
      truck({ plate: "PQL 5292", maxPallets: 8, coverageZones: ["P3"] }), // P3 not adjacent
    ];
    const sel = selectTruck({ pallets: 4, zone: "K1" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PLX 2406");
  });

  it("still assigns the smallest fitting truck when nobody covers or is adjacent", () => {
    const candidates = [
      truck({ plate: "PND 1888", maxPallets: 14, coverageZones: ["P3"] }),
      truck({ plate: "PQL 5292", maxPallets: 8, coverageZones: ["P3"] }),
    ];
    const sel = selectTruck({ pallets: 4, zone: "K2" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PQL 5292"); // smaller of the two non-matching trucks
  });
});

describe("selectTruck — one active trip per driver (no consolidation onto a busy driver)", () => {
  it("does NOT stack a second order onto a truck already serving the same zone — idle truck wins", () => {
    const candidates = [
      // Already carrying 4 pallets to K1 with room for 4 more — but it's busy, so
      // under the one-active-trip rule it is no longer a candidate.
      truck({ plate: "PRJ 5292", maxPallets: 8, currentLoad: 4, coverageZones: ["K1"], activeZones: ["K1"] }),
      // Idle truck that also covers K1.
      truck({ plate: "PQL 5292", maxPallets: 8, coverageZones: ["K1"] }),
    ];
    const sel = selectTruck({ pallets: 3, zone: "K1" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PQL 5292"); // the busy same-zone truck is excluded
  });

  it("returns null when the only fitting truck is already on an active trip", () => {
    const candidates = [
      truck({ plate: "PRJ 5292", maxPallets: 8, currentLoad: 4, coverageZones: ["K1"], activeZones: ["K1"] }),
    ];
    expect(selectTruck({ pallets: 3, zone: "K1" }, candidates, ADJACENCY)).toBeNull();
  });

  it("treats a truck busy with a different zone as unavailable", () => {
    const candidates = [
      // Out delivering to A2 — must not be handed a K1 order.
      truck({ plate: "PLX 2406", maxPallets: 16, currentLoad: 5, coverageZones: ["K1"], activeZones: ["A2"] }),
      truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["K1"] }),
    ];
    const sel = selectTruck({ pallets: 3, zone: "K1" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PRJ 5292");
  });
});

describe("selectTruck — A1/A2 driver-priority (28 Jul 2026 revision + R3 answers)", () => {
  // PND 1888 is the primary since the 28 Jul revision (Azmi's A1/A2 priority
  // moved with him, PLX 2406 → PND 1888). His R3 answers (29 Jul, DOCUMENT
  // tier) settled the rest: NO named backup ("You can assign any … depend
  // cargo size" — A2) and the PRH small-load rule is REMOVED ("Remove it,
  // PRH 5292 not priority for Taiping / Ipoh" — A3).
  const pnd = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PND 1888", maxPallets: 14, coverageZones: ["A1", "A2", "P1", "P2"], ...over });
  const psa = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PSA 5292", maxPallets: 14, coverageZones: ["P1", "P2", "P3", "K1", "K2"], ...over });
  const prh = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["P1", "P2", "P3", "K1", "K2", "A1", "A2"], ...over });
  const prj = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["P1", "P2", "P3", "K1", "K2"], ...over });

  it("A1: picks PND 1888 (the primary) over PRH even for a 1-pallet load", () => {
    const sel = selectTruck({ pallets: 1, zone: "A1" }, [pnd(), prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PND 1888");
  });

  it("A2: while PND is free it locks the zone — a smaller fitting truck never wins", () => {
    const sel = selectTruck({ pallets: 6, zone: "A2" }, [pnd(), psa(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PND 1888");
  });

  it("A1: when PND is absent, a 1-pallet order goes to PRH (smallest fit)", () => {
    const sel = selectTruck({ pallets: 1, zone: "A1" }, [psa(), prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PRH 5292");
  });

  it("REGRESSION (R3 A3): a 2-pallet A1/A2 order MAY go to PRH now — the strictly-under-2 cap died with the removed rule", () => {
    // The old sheet remark capped PRH to <2 pallets on A1/A2. Mr. Teh removed
    // the rule; PRH's only remaining constraint is its physical max_pallets (2).
    const sel = selectTruck({ pallets: 2, zone: "A2" }, [prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PRH 5292"); // covers A2 + smallest fit
  });

  it("treats a busy PND as unavailable, opening A1/A2 to the whole fitting fleet", () => {
    const sel = selectTruck(
      { pallets: 2, zone: "A2" },
      [pnd({ currentLoad: 5, activeZones: ["P2"] }), psa(), prj()],
      ADJACENCY
    );
    // No named backup (R3 A2): normal ranking. Nobody covers A2 here, so
    // Best-Fit picks the smallest fitting truck.
    expect(sel?.plate).toBe("PRJ 5292");
  });

  it("excludes PND when it is already on an active A2 trip (no same-zone stacking)", () => {
    const sel = selectTruck(
      { pallets: 2, zone: "A2" },
      [pnd({ currentLoad: 5, activeZones: ["A2"] }), prj()],
      ADJACENCY
    );
    expect(sel?.plate).toBe("PRJ 5292");
  });

  it("falls back to a 17.5ft lorry when the primary is not in the pool", () => {
    const sel = selectTruck({ pallets: 4, zone: "A1" }, [prj()], ADJACENCY);
    expect(sel?.plate).toBe("PRJ 5292");
  });

  it("an A1/A2 order the primary cannot FIT opens the fleet — the lock only holds while PND fits", () => {
    // 15 pallets: PND (14) is free but does not fit, so it never enters the
    // fitting set and cannot lock the zone. Nothing else fits either → null
    // (the customer pool's largest truck is 14 since PLX went interplant).
    const sel = selectTruck({ pallets: 15, zone: "A2" }, [pnd(), psa(), prj()], ADJACENCY);
    expect(sel).toBeNull();
  });

  it("widening never bypasses capacity — an A1 order too big for the free fleet still fails", () => {
    const sel = selectTruck({ pallets: 10, zone: "A1" }, [prj(), prh()], ADJACENCY);
    expect(sel).toBeNull();
  });

  it("leaves non-A1/A2 (P2) behaviour unchanged: smallest fitting coverage truck", () => {
    const sel = selectTruck({ pallets: 3, zone: "P2" }, [pnd(), prj(), prh()], ADJACENCY);
    expect(sel?.plate).toBe("PRJ 5292"); // PRH(2) too small for 3; PRJ(8) < PND(14)
  });
});

describe("enRouteZones — return-trip matching", () => {
  it("offers A1 (Taiping) pickups on an A2 (Ipoh) run", () => {
    expect(enRouteZones("A2")).toEqual(["A1"]);
  });

  it("returns nothing for zones with no corridor", () => {
    expect(enRouteZones("P1")).toEqual([]);
    expect(enRouteZones(null)).toEqual([]);
  });
});

describe("autoAssignNote — the persisted decision log", () => {
  it("records driver, plate and the engine's selection reason", () => {
    const sel = selectTruck(
      { pallets: 2, zone: "K1" },
      [truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["K1"] })],
      ADJACENCY
    )!;
    expect(autoAssignNote("Ali", sel.plate, sel.reason)).toBe(
      "Ali · PRJ 5292 (auto — driver covers zone K1; fits 2/8 pallets)"
    );
  });

  it("falls back to the plate when the driver name is unknown", () => {
    expect(autoAssignNote(null, "PND 1888", "adjacent-zone driver for K1; fits 1/14 pallets")).toBe(
      "PND 1888 (auto — adjacent-zone driver for K1; fits 1/14 pallets)"
    );
  });
});

describe("autoDispatchFailureNote — the persisted failure reason", () => {
  // Built with the real estimator so the note stays in lockstep with the
  // OperatingWindowEstimate shape the engine actually produces.
  it("names the operating window when the pickup falls outside it", () => {
    const est = estimateOperatingWindow({
      pickupDateTime: new Date("2026-07-05T21:00:00Z"), // 05:00 MYT on 6 Jul
      stopCount: 1,
      stopPoints: [1],
      windowStart: "07:00",
      windowEnd: "18:00",
    });
    expect(est.reason).toBe("pickup_outside_window");
    expect(autoDispatchFailureNote(est)).toBe(
      "Pickup is outside the operating window (07:00–18:00)."
    );
  });

  it("names the estimated completion when the route would finish past the window", () => {
    const est = estimateOperatingWindow({
      pickupDateTime: new Date("2026-07-06T09:30:00Z"), // 17:30 MYT
      stopCount: 2,
      stopPoints: [6, 6], // two long A2-grade legs — cannot finish by 18:00
      windowStart: "07:00",
      windowEnd: "18:00",
    });
    expect(est.reason).toBe("completion_past_window");
    expect(autoDispatchFailureNote(est)).toMatch(
      /^Estimated completion \d{2}:\d{2} exceeds the 18:00 operating window\.$/
    );
  });

  it("falls back to the no-capacity message when no window was breached", () => {
    expect(autoDispatchFailureNote(null)).toBe(
      "No available truck has capacity for this order."
    );
  });
});

describe("selectTruck — long-haul zone (KL)", () => {
  // KL is out of every truck's coverage AND the adjacency matrix, so an order
  // there falls back to tier 2 ("any free truck") — the smallest that fits.
  // Previously untested; the ADJACENCY fixture above includes it.
  it.each(["KL"])(
    "assigns a %s order to the smallest fitting truck (no coverage, no adjacency)",
    (zone) => {
      const candidates = [
        truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["A1", "A2", "P1", "P2"] }),
        truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["P1", "P2", "K1"] }),
        truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["P1", "P2"] }),
      ];
      const sel = selectTruck({ pallets: 1, zone }, candidates, ADJACENCY);
      expect(sel?.plate).toBe("PRH 5292"); // 1 pallet → smallest truck, coverage irrelevant
      expect(sel?.reason).toContain(`next available truck for ${zone}`);
    }
  );

  it("still respects capacity for a long-haul zone (skips trucks too small)", () => {
    const candidates = [
      truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["A1", "A2"] }),
      truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["P1"] }),
      truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["P1"] }),
    ];
    const sel = selectTruck({ pallets: 10, zone: "KL" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PLX 2406"); // only the 16-pallet truck fits 10
  });
});

// Manual-unassignment hold (TEST TO REQUESTOR item 2 / feedback item 15): a
// ticket an admin unassigns returns to pending and must NOT be auto-assigned
// again. autoDispatchBlockReason is the single gate autoDispatchTrip runs, so
// every automatic path (pending sweep, create/edit hook, admin auto-assign
// endpoint) honours the `auto_dispatch_paused` pin — not just the sweep.
describe("autoDispatchBlockReason — the auto-dispatch eligibility gate", () => {
  it("allows a plain pending, not-paused trip (returns null → eligible)", () => {
    expect(autoDispatchBlockReason({ status: "pending", auto_dispatch_paused: false })).toBeNull();
  });

  it("BLOCKS a manually-unassigned (paused) pending trip — no automatic path may pick it up", () => {
    expect(
      autoDispatchBlockReason({ status: "pending", auto_dispatch_paused: true })
    ).toMatch(/manual assignment/i);
  });

  it("leaves a non-pending trip alone — never auto-dispatches assigned/in_progress/completed/cancelled", () => {
    for (const status of ["assigned", "in_progress", "pending_approval", "completed", "cancelled"]) {
      // Even with the pin absent, a non-pending trip is not dispatchable — the
      // status reason wins, so an active/finished trip is never silently reset.
      expect(autoDispatchBlockReason({ status, auto_dispatch_paused: false })).toBe("Trip is not pending.");
      // And a paused non-pending trip is likewise blocked (status checked first).
      expect(autoDispatchBlockReason({ status, auto_dispatch_paused: true })).toBe("Trip is not pending.");
    }
  });

  it("the pin is what distinguishes two pending trips — only the paused one is blocked", () => {
    expect(autoDispatchBlockReason({ status: "pending", auto_dispatch_paused: false })).toBeNull();
    expect(autoDispatchBlockReason({ status: "pending", auto_dispatch_paused: true })).not.toBeNull();
  });
});
