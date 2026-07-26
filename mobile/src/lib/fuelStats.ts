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
