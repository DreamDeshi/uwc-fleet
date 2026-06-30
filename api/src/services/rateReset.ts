/**
 * Pure planner for "reset truck rates to UWC spec defaults" (no DB, no I/O) so
 * it is unit-testable. Given the authoritative spec trucks (from
 * docs/uwc-spec.json) and the current DB truck rate rows, it computes which
 * trucks need updating (with old→new per field), which are already at spec, and
 * which spec plates are missing from the DB (skipped — never created).
 *
 * Only the four rate/capacity fields are in scope: entitled_claim_weekday,
 * entitled_claim_offpeak, daily_deduction_points, max_pallets. priority_zones,
 * truck type, documents etc. are untouched (priority_zones is driver-owned).
 */
import type { SpecTruck } from "../lib/uwcSpec";

// Current DB rate values for a truck (Decimals already coerced to numbers).
export interface DbTruckRates {
  plate: string;
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
  max_pallets: number;
}

// The spec values a truck will be set to (DB column names).
export interface ResetTargetValues {
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
  max_pallets: number;
}

export interface FieldChange {
  field: keyof ResetTargetValues;
  from: number;
  to: number;
}

export interface ResetUpdate {
  plate: string;
  data: ResetTargetValues; // full target (the spec values)
  changes: FieldChange[]; // only the fields that actually differ
}

export interface RateResetPlan {
  updated: ResetUpdate[]; // trucks that differ from spec → will be reset
  alreadyAtSpec: string[]; // plates already matching spec exactly
  skipped: string[]; // spec plates not present in the DB (not created)
}

/** Map a spec-truck's rate fields to the DB column names. */
function specTargets(t: SpecTruck): ResetTargetValues {
  return {
    entitled_claim_weekday: t.weekday_rate,
    entitled_claim_offpeak: t.offpeak_rate,
    daily_deduction_points: t.daily_deduction,
    max_pallets: t.max_pallets,
  };
}

export function planRateReset(specTrucks: SpecTruck[], dbTrucks: DbTruckRates[]): RateResetPlan {
  const byPlate = new Map(dbTrucks.map((t) => [t.plate, t]));
  const plan: RateResetPlan = { updated: [], alreadyAtSpec: [], skipped: [] };

  for (const spec of specTrucks) {
    const db = byPlate.get(spec.plate);
    if (!db) {
      // A spec plate the DB doesn't have: skip it, never create it.
      plan.skipped.push(spec.plate);
      continue;
    }

    const target = specTargets(spec);
    const current: ResetTargetValues = {
      entitled_claim_weekday: db.entitled_claim_weekday,
      entitled_claim_offpeak: db.entitled_claim_offpeak,
      daily_deduction_points: db.daily_deduction_points,
      max_pallets: db.max_pallets,
    };

    const changes: FieldChange[] = (Object.keys(target) as (keyof ResetTargetValues)[])
      .filter((f) => current[f] !== target[f])
      .map((f) => ({ field: f, from: current[f], to: target[f] }));

    if (changes.length === 0) {
      plan.alreadyAtSpec.push(spec.plate);
    } else {
      plan.updated.push({ plate: spec.plate, data: target, changes });
    }
  }

  return plan;
}
