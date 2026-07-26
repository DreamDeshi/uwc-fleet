// Odometer plausibility for fuel logs (DG-M5). Pure — unit-tested in
// tests/fuelOdometer.test.ts.
//
// The fuel analytics (RM/km, L/100km, CO2e in lib/fuelSummary) are only as
// good as the odometer series, and the create route used to accept ANY
// positive number — a fat-fingered 12,345 → 1,235 silently poisoned every
// derived metric. The rule: within one truck's timeline, odometer readings
// must be non-decreasing. Backdating stays allowed (logging yesterday's fill
// today is normal), so the check is INTERVAL-aware: the candidate must fit
// between its chronological neighbours, not merely exceed the latest reading.

export interface FuelOdometerPoint {
  /** Km reading; legacy rows may be null (excluded from the check). */
  odometer: number | null;
  logged_at: Date;
}

export interface OdometerViolation {
  /** The neighbouring reading the candidate conflicts with. */
  neighborKm: number;
  /** "earlier": candidate is below a reading logged before it.
   *  "later": candidate is above a reading logged after it. */
  neighbor: "earlier" | "later";
}

/**
 * Null when the candidate fits its truck's odometer timeline; otherwise which
 * neighbour it contradicts. Ties on logged_at count as "before" the candidate
 * (two fills stamped the same minute must still be non-decreasing).
 */
export function odometerViolation(
  existing: FuelOdometerPoint[],
  candidate: { odometer: number; logged_at: Date }
): OdometerViolation | null {
  let prev: FuelOdometerPoint | null = null;
  let next: FuelOdometerPoint | null = null;
  for (const p of existing) {
    if (p.odometer === null || p.odometer === undefined) continue;
    if (p.logged_at.getTime() <= candidate.logged_at.getTime()) {
      if (!prev || p.logged_at.getTime() > prev.logged_at.getTime()) prev = p;
    } else if (!next || p.logged_at.getTime() < next.logged_at.getTime()) {
      next = p;
    }
  }
  if (prev && candidate.odometer < (prev.odometer as number)) {
    return { neighborKm: prev.odometer as number, neighbor: "earlier" };
  }
  if (next && candidate.odometer > (next.odometer as number)) {
    return { neighborKm: next.odometer as number, neighbor: "later" };
  }
  return null;
}
