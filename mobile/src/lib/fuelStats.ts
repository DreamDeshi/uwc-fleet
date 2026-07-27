// Driver-side fuel arithmetic. Pure module (no React Native imports) —
// unit-tested in fuelStats.test.ts, same discipline as lib/earnings.ts.
//
// The driver ENTERS every fuel fill but got almost nothing back — the fuel
// data flowed one way, into the admin panel. This month-scope rollup gives
// the person doing the data entry a feedback loop on the modal itself.

export interface FuelLogLike {
  liters: string | number;
  cost: string | number;
  logged_at: string;
}

export interface MonthFuelTotals {
  fills: number;
  litres: number;
  costRm: number;
}

// Gentle fill-up reminder threshold. ⚠ OUR OWN choice (5 days ≈ a working
// week between fills for an active truck), NOT a client rule — Mr. Teh's
// R2 answer decides whether logging becomes REQUIRED; until then this only
// accents the existing Log Fuel card, it never nags or blocks.
export const FUEL_NUDGE_AFTER_DAYS = 5;

/** Whole days since the last fill, or null when never logged. */
export function daysSinceFill(lastLoggedAt: string | Date | null | undefined, now: Date): number | null {
  if (!lastLoggedAt) return null;
  const at = new Date(lastLoggedAt).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / (24 * 60 * 60 * 1000)));
}

/** True when the Log Fuel card should carry the reminder accent. */
export function fuelLogNudge(lastLoggedAt: string | Date | null | undefined, now: Date): boolean {
  const days = daysSinceFill(lastLoggedAt, now);
  return days === null || days >= FUEL_NUDGE_AFTER_DAYS;
}

/** Totals for the LOCAL calendar month containing `now`. */
export function monthFuelTotals(logs: FuelLogLike[], now: Date): MonthFuelTotals {
  let fills = 0;
  let litres = 0;
  let costRm = 0;
  for (const log of logs) {
    const at = new Date(log.logged_at);
    if (at.getFullYear() !== now.getFullYear() || at.getMonth() !== now.getMonth()) continue;
    fills += 1;
    litres += Number(log.liters) || 0;
    costRm += Number(log.cost) || 0;
  }
  return {
    fills,
    litres: Math.round(litres * 10) / 10,
    costRm: Math.round(costRm * 100) / 100,
  };
}
