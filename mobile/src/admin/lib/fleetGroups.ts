// Service-class grouping for the fleet-map truck list (28 Jul owner design).
//
// SHIP-EARLY CONTRACT: `INTERPLANT_PLATES` is EMPTY today, so the whole fleet
// falls into one "customer" group and `groupFleet` returns a single group —
// the UI renders the flat list exactly as before. The fleet-update build
// (ON HOLD pending Mr. Teh's answers — FLEET_UPDATE_PLAN_2026-07-28.md) adds
// "PLX 2406" and "PPE 2406" here, and the grouped UI lights up on its own.
//
// RECONCILIATION INVARIANT (the owner's hard requirement): a truck that is
// out on the map (has a live GPS fix) is NOT a list row, but it still counts
// in its class header — so every class total equals activeOnMap + rows, and
// the class totals sum to the entire fleet. "A dashboard where the numbers
// don't add up is worse than a flat list." Pinned by fleetGroups.test.ts.
//
// Pure module (no React, no i18n) so the invariant is unit-testable.

export type ServiceClass = "customer" | "interplant";

/** Interplant-only plates. EMPTY until the 28-Jul fleet update ships. */
export const INTERPLANT_PLATES: readonly string[] = [];

/** Minimal structural slice of the admin Truck this module needs. */
export interface GroupableTruck {
  plate: string;
  status: string; // "active" | "idle" | "maintenance" | "retired"
}

export interface FleetGroup<T extends GroupableTruck = GroupableTruck> {
  key: ServiceClass;
  /** EVERY truck in the class — on-map trucks included. */
  total: number;
  /** Trucks with a live fix: map markers, deliberately NOT list rows. */
  activeOnMap: number;
  /** Off-map trucks by status — what the header pills show. */
  counts: { idle: number; maintenance: number; retired: number };
  /** The off-map trucks, in input order — the list rows. */
  rows: T[];
}

export function serviceClassOf(
  plate: string,
  interplantPlates: readonly string[] = INTERPLANT_PLATES
): ServiceClass {
  return interplantPlates.includes(plate) ? "interplant" : "customer";
}

/**
 * Split the fleet into service-class groups for the narrow list. Groups are
 * returned in display order (customer first) and ONLY for classes that have
 * at least one truck — so with today's empty INTERPLANT_PLATES the result is
 * exactly one group and callers render the ungrouped flat list.
 */
export function groupFleet<T extends GroupableTruck>(
  trucks: readonly T[],
  hasFix: (plate: string) => boolean,
  interplantPlates: readonly string[] = INTERPLANT_PLATES
): FleetGroup<T>[] {
  const make = (key: ServiceClass): FleetGroup<T> => ({
    key,
    total: 0,
    activeOnMap: 0,
    counts: { idle: 0, maintenance: 0, retired: 0 },
    rows: [],
  });
  const groups: Record<ServiceClass, FleetGroup<T>> = {
    customer: make("customer"),
    interplant: make("interplant"),
  };

  for (const truck of trucks) {
    const g = groups[serviceClassOf(truck.plate, interplantPlates)];
    g.total += 1;
    if (hasFix(truck.plate)) {
      // On the map — counted in the header, never a row.
      g.activeOnMap += 1;
      continue;
    }
    if (truck.status === "maintenance") g.counts.maintenance += 1;
    else if (truck.status === "retired") g.counts.retired += 1;
    else g.counts.idle += 1; // "idle" and any unknown status read as idle,
    // matching the list's statusTag default — never silently dropped.
    g.rows.push(truck);
  }

  return [groups.customer, groups.interplant].filter((g) => g.total > 0);
}
