import { describe, it, expect } from "vitest";
import {
  selectTruck,
  enRouteZones,
  type TruckCandidate,
} from "../src/services/dispatchEngine";

// Adjacency from the seed (Mr. Teh's email): P2↔K1, P2↔A1.
const ADJACENCY: Record<string, string[]> = {
  P1: [],
  P2: ["K1", "A1"],
  P3: [],
  K1: ["P2"],
  K2: [],
  A1: ["P2"],
  A2: [],
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
    const candidates = [
      truck({ plate: "PND 1888", maxPallets: 14, coverageZones: ["P1", "P2", "P3", "K1", "K2"] }),
      truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["A1", "A2", "P1", "P2"] }),
    ];
    // Order to A2 — only PLX2406 covers A2, so it wins despite being larger.
    const sel = selectTruck({ pallets: 6, zone: "A2" }, candidates, ADJACENCY);
    expect(sel?.plate).toBe("PLX 2406");
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

describe("selectTruck — A1/A2 driver-priority (INTERNAL LORRY RATE sheet)", () => {
  // Real coverage zones from the sheet. PRH 5292 covers ALL zones but is gated
  // to <2 pallets on A1/A2; the 17.5ft lorries never serve A1/A2.
  const plx = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PLX 2406", maxPallets: 16, coverageZones: ["A1", "A2", "P1", "P2"], ...over });
  const pnd = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PND 1888", maxPallets: 14, coverageZones: ["P1", "P2", "P3", "K1", "K2"], ...over });
  const prh = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PRH 5292", maxPallets: 2, coverageZones: ["P1", "P2", "P3", "K1", "K2", "A1", "A2"], ...over });
  const prj = (over: Partial<TruckCandidate> = {}) =>
    truck({ plate: "PRJ 5292", maxPallets: 8, coverageZones: ["P1", "P2", "P3", "K1", "K2"], ...over });

  it("A1: picks PLX 2406 (the primary) over PRH even for a 1-pallet load", () => {
    const sel = selectTruck({ pallets: 1, zone: "A1" }, [plx(), prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PLX 2406");
  });

  it("A1: when PLX is absent, a 1-pallet order may go to PRH (smallest fit)", () => {
    const sel = selectTruck({ pallets: 1, zone: "A1" }, [pnd(), prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PRH 5292");
  });

  it("A2: when PLX is absent, a 2-pallet order excludes PRH and falls to PND (the backup)", () => {
    const sel = selectTruck({ pallets: 2, zone: "A2" }, [pnd(), prh(), prj()], ADJACENCY);
    expect(sel?.plate).toBe("PND 1888");
  });

  it("A2: when PLX is available, PND (the backup) is excluded — PLX wins", () => {
    const sel = selectTruck({ pallets: 6, zone: "A2" }, [plx(), pnd()], ADJACENCY);
    expect(sel?.plate).toBe("PLX 2406");
  });

  it("treats a busy PLX as unavailable, opening A1/A2 to the backups", () => {
    // PLX is out on a P2 run → not available; PND backs up the A2 order.
    const sel = selectTruck(
      { pallets: 2, zone: "A2" },
      [plx({ currentLoad: 5, activeZones: ["P2"] }), pnd()],
      ADJACENCY
    );
    expect(sel?.plate).toBe("PND 1888");
  });

  it("excludes PLX when it is already on an active A2 trip (no same-zone stacking) — falls to PND", () => {
    // PLX is mid-delivery to A2 (currentLoad > 0). Even though the new order is
    // also A2, the one-active-trip rule bars consolidation onto a busy driver, so
    // the order backs up to PND rather than re-picking the in_progress PLX 2406.
    const sel = selectTruck(
      { pallets: 2, zone: "A2" },
      [plx({ currentLoad: 5, activeZones: ["A2"] }), pnd()],
      ADJACENCY
    );
    expect(sel?.plate).toBe("PND 1888");
  });

  it("never auto-assigns A1/A2 to a 17.5ft lorry — returns null if only those are free", () => {
    const sel = selectTruck({ pallets: 4, zone: "A1" }, [prj()], ADJACENCY);
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
