import { describe, it, expect } from "vitest";
import { groupFleet, serviceClassOf, INTERPLANT_PLATES } from "./fleetGroups";

// The post-fleet-update fleet (28 Jul workbook): 9 trucks, PLX 2406 + PPE 2406
// interplant. The data change itself is ON HOLD — these tests inject the
// plates, which is exactly how the shipped code will receive them.
const FUTURE_INTERPLANT = ["PLX 2406", "PPE 2406"];
const FUTURE_FLEET = [
  { plate: "PLX 2406", status: "idle" },
  { plate: "PPE 2406", status: "idle" },
  { plate: "PND 1888", status: "idle" },
  { plate: "PSA 5292", status: "idle" },
  { plate: "PRJ 5292", status: "idle" },
  { plate: "PQL 5292", status: "idle" },
  { plate: "PPE 1804", status: "idle" },
  { plate: "PRH 5292", status: "idle" },
  { plate: "4 Wheel", status: "maintenance" },
];

describe("groupFleet — reconciliation invariant (owner requirement, 28 Jul)", () => {
  it("class totals INCLUDE trucks out on the map and always sum to the full fleet", () => {
    // PND is out on a trip (map marker) — it must vanish from the rows but
    // NOT from its class total.
    const onMap = new Set(["PND 1888"]);
    const groups = groupFleet(FUTURE_FLEET, (p) => onMap.has(p), FUTURE_INTERPLANT);

    // Σ class totals === entire fleet, always.
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(FUTURE_FLEET.length);

    // Every group internally reconciles: total = on-map + listed rows.
    for (const g of groups) {
      expect(g.activeOnMap + g.rows.length).toBe(g.total);
      expect(g.counts.idle + g.counts.maintenance + g.counts.retired).toBe(g.rows.length);
    }

    const customer = groups.find((g) => g.key === "customer")!;
    const interplant = groups.find((g) => g.key === "interplant")!;
    expect(customer.total).toBe(7); // incl. the on-map PND
    expect(customer.activeOnMap).toBe(1);
    expect(customer.rows.map((r) => r.plate)).not.toContain("PND 1888");
    expect(customer.counts).toEqual({ idle: 5, maintenance: 1, retired: 0 });
    expect(interplant.total).toBe(2);
    expect(interplant.counts).toEqual({ idle: 2, maintenance: 0, retired: 0 });
  });

  it("an entirely-active class still reconciles (rows empty, header count carries it)", () => {
    const groups = groupFleet(
      FUTURE_FLEET,
      (p) => p === "PLX 2406" || p === "PPE 2406", // both interplant shuttles out
      FUTURE_INTERPLANT
    );
    const interplant = groups.find((g) => g.key === "interplant")!;
    expect(interplant.rows).toHaveLength(0);
    expect(interplant.activeOnMap).toBe(2);
    expect(interplant.total).toBe(2); // nothing lost — the header still says 2
  });
});

describe("groupFleet — ship-early single-class fallback", () => {
  it("with the SHIPPED (empty) interplant list, the whole fleet is ONE group → UI renders the flat list", () => {
    expect(INTERPLANT_PLATES).toHaveLength(0); // the ship-early contract itself
    const groups = groupFleet(FUTURE_FLEET, () => false);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("customer");
    expect(groups[0].total).toBe(FUTURE_FLEET.length);
  });

  it("classes with zero trucks never render a group (no empty 'Interplant' header)", () => {
    const groups = groupFleet(
      [{ plate: "PND 1888", status: "idle" }],
      () => false,
      FUTURE_INTERPLANT
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("customer");
  });

  it("empty fleet → no groups (panel hides, no NaN counts)", () => {
    expect(groupFleet([], () => false, FUTURE_INTERPLANT)).toHaveLength(0);
  });
});

describe("serviceClassOf", () => {
  it("classifies the two 28-Jul interplant plates and defaults everything else to customer", () => {
    expect(serviceClassOf("PLX 2406", FUTURE_INTERPLANT)).toBe("interplant");
    expect(serviceClassOf("PPE 2406", FUTURE_INTERPLANT)).toBe("interplant");
    expect(serviceClassOf("PPE 1804", FUTURE_INTERPLANT)).toBe("customer"); // the near-twin plate
    expect(serviceClassOf("PSA 5292", FUTURE_INTERPLANT)).toBe("customer");
  });

  it("an unknown status counts as idle, never silently dropped from the reconciliation", () => {
    const groups = groupFleet(
      [{ plate: "PND 1888", status: "definitely-not-a-status" }],
      () => false,
      FUTURE_INTERPLANT
    );
    expect(groups[0].counts.idle).toBe(1);
    expect(groups[0].rows).toHaveLength(1);
  });
});
