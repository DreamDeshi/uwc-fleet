// Service-class grouping for the fleet-map truck list (28 Jul owner design).
//
// LIT UP 29 Jul 2026: the fleet revision shipped (Mr. Teh's R3 answers cleared
// the hold), so `INTERPLANT_PLATES` now names the two Batu Kawan shuttles and
// the grouped UI renders exactly as the ship-early contract promised. Must
// mirror the plates marked service_class "interplant" in docs/uwc-spec.json.
//
// RECONCILIATION INVARIANT (the owner's hard requirement): a truck that is
// out on the map (has a live GPS fix) is NOT a list row, but it still counts
// in its class header — so every class total equals activeOnMap + rows, and
// the class totals sum to the entire fleet. "A dashboard where the numbers
// don't add up is worse than a flat list." Pinned by fleetGroups.test.ts.
//
// Pure module (no React, no i18n) so the invariant is unit-testable.

export type ServiceClass = "customer" | "interplant";

/** Interplant-only plates (the 28 Jul 2026 revision, live since 29 Jul). */
export const INTERPLANT_PLATES: readonly string[] = ["PLX 2406", "PPE 2406"];

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
