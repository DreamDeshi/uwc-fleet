import type { DashboardKpis, LivePosition, Truck } from "../types";

/**
 * The derived figures on the admin phone Home (design frame 1), kept pure so
 * the arithmetic is unit-tested rather than tangled in JSX.
 *
 * Two of them are the whole point of the frame's additions:
 *
 *  - THE ATTENTION STRIP in the blue header. The dispatcher's first question on
 *    opening the app is "is anything stuck?", and the answer used to be a panel
 *    halfway down the scroll.
 *  - THE IDLE LIST under the fleet map. Only trucks with a live GPS fix can be
 *    markers, so a truck that is off, parked or in the workshop simply was not
 *    on the map — indistinguishable from one the map had lost. Listing them
 *    below, with the reason, closes that hole.
 */

/** A truck is on the map iff the live feed has a position for its plate. */
export function isTracked(truck: Truck, live: LivePosition[]): boolean {
  return live.some((p) => p.plate === truck.plate);
}

/**
 * Trucks the map cannot show, worst first: maintenance, then idle, then any
 * active truck with no fix (which usually means the driver's phone is off).
 * Retired trucks are excluded — they are not fleet any more.
 */
export function untrackedTrucks(trucks: Truck[], live: LivePosition[]): Truck[] {
  const rank: Record<Truck["status"], number> = { maintenance: 0, idle: 1, active: 2, retired: 3 };
  return trucks
    .filter((tr) => tr.status !== "retired" && !isTracked(tr, live))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.plate.localeCompare(b.plate));
}

/** Trucks currently sending positions — the map's marker count. */
export function trackedCount(trucks: Truck[], live: LivePosition[]): number {
  return trucks.filter((tr) => tr.status !== "retired" && isTracked(tr, live)).length;
}

export interface HomeAttention {
  /** i18n key for the one-line strip. */
  key: string;
  count: number;
}

/**
 * The single most urgent thing, or null for a quiet fleet.
 *
 * Ordered by who is BLOCKED: a booking the engine could not place has nobody
 * driving it and no truck reserved, so it outranks a trip that is merely
 * running late. Only one line is ever shown — a header strip that lists three
 * problems is a panel, and the panel already exists further down.
 */
export function homeAttention(kpis: DashboardKpis | undefined): HomeAttention | null {
  if (!kpis) return null;
  if (kpis.auto_dispatch_failed > 0) {
    return { key: "admin.home.stripDispatchFailed", count: kpis.auto_dispatch_failed };
  }
  if (kpis.awaiting_manual > 0) {
    return { key: "admin.home.stripAwaitingManual", count: kpis.awaiting_manual };
  }
  return null;
}
