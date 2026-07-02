import { getTripDayStart, mytDateKey } from "./incentiveEngine";

/**
 * Roadworthiness gate for dispatch (audit item: expiry dates were read for
 * ALERTS only and never blocked assignment).
 *
 * Policy:
 *  - insurance / road tax expired → HARD block. Never overridable — an
 *    uninsured or untaxed truck on the road is a liability, not a judgment
 *    call. Auto-dispatch excludes the truck; manual approve denies.
 *  - permit expired → manual approve warns (409 TRUCK_PERMIT_EXPIRED) and the
 *    admin may force ("Assign anyway", audit-logged). Auto-dispatch ALSO
 *    excludes it — the engine has no force, so the trip goes needs-attention
 *    and a human makes the call.
 *  - a null date = no record → not blocked (the expiry ALERTS keep chasing
 *    missing/near-expiry data; blocking on unknowns would brick the fleet).
 *
 * A document is valid THROUGH its expiry date (MYT): expired means the expiry
 * day is strictly before the day being dispatched for.
 */

export interface TruckDocDates {
  insurance_expiry: Date | null;
  permit_expiry: Date | null;
  road_tax_expiry: Date | null;
}

/** True when `expiry` (MYT day) is strictly before `validOn`'s MYT day. */
export function isDocExpired(expiry: Date | null, validOn: Date): boolean {
  if (!expiry) return false;
  return mytDateKey(expiry) < mytDateKey(validOn);
}

export interface TruckExpiryIssues {
  /** Hard-block documents that are expired (insurance / road tax). */
  hard: { doc: "insurance" | "road tax"; expiry: Date }[];
  /** Expired permit (overridable on manual assign), or null. */
  permitExpired: Date | null;
}

export function truckExpiryIssues(truck: TruckDocDates, validOn: Date): TruckExpiryIssues {
  const hard: TruckExpiryIssues["hard"] = [];
  if (isDocExpired(truck.insurance_expiry, validOn)) {
    hard.push({ doc: "insurance", expiry: truck.insurance_expiry! });
  }
  if (isDocExpired(truck.road_tax_expiry, validOn)) {
    hard.push({ doc: "road tax", expiry: truck.road_tax_expiry! });
  }
  return {
    hard,
    permitExpired: isDocExpired(truck.permit_expiry, validOn) ? truck.permit_expiry : null,
  };
}

/**
 * Prisma where-fragment for the auto-dispatch candidate query — the SQL form
 * of truckExpiryIssues: every document must be absent or still valid on the
 * MYT day of `validOn` (>= that day's start instant, matching the "valid
 * through the expiry date" rule above).
 */
export function roadworthyWhere(validOn: Date): {
  AND: (
    | { OR: ({ insurance_expiry: null } | { insurance_expiry: { gte: Date } })[] }
    | { OR: ({ road_tax_expiry: null } | { road_tax_expiry: { gte: Date } })[] }
    | { OR: ({ permit_expiry: null } | { permit_expiry: { gte: Date } })[] }
  )[];
} {
  const dayStart = getTripDayStart(validOn);
  return {
    AND: [
      { OR: [{ insurance_expiry: null }, { insurance_expiry: { gte: dayStart } }] },
      { OR: [{ road_tax_expiry: null }, { road_tax_expiry: { gte: dayStart } }] },
      { OR: [{ permit_expiry: null }, { permit_expiry: { gte: dayStart } }] },
    ],
  };
}
