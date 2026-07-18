/**
 * Conformance-harness fixtures — the real fleet, zones, points and rates loaded
 * straight from the authoritative spec (docs/uwc-spec.json), so the incentive
 * and dispatch conformance suites test against the SAME numbers the seed and the
 * app use. Nothing here is hand-duplicated: if a rate changes in the spec, these
 * fixtures (and every conformance assertion derived from them) move with it.
 *
 * Pure data + tiny helpers — no DB, no Date.now() — so the suites stay in the
 * fast unit tier (npm test, no Docker).
 */
import fs from "fs";
import path from "path";
import type { TruckCandidate } from "../../src/services/dispatchEngine";
import {
  calculateDeliveryIncentive,
  type DeliveryIncentiveResult,
} from "../../src/services/incentiveEngine";

const SPEC_PATH = path.resolve(__dirname, "../../../docs/uwc-spec.json");
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));

export interface FleetTruck {
  plate: string;
  maxPallets: number;
  weekday: number; // entitled_claim_weekday (peak)
  offpeak: number; // entitled_claim_offpeak
  deduction: number; // daily_deduction points
  zones: string[]; // priority_zones (driver coverage)
  hasDriver: boolean; // false for "4 Wheel" (no driver in the workbook) → not dispatchable
}

// A plate is dispatchable only if the workbook binds a driver to it. "4 Wheel"
// has no driver_assignments row, so it can never be auto-assigned — the harness
// asserts that below and excludes it from the candidate pool here.
const drivenPlates = new Set<string>((spec.driver_assignments as any[]).map((d) => d.truck));

export const FLEET: FleetTruck[] = (spec.trucks as any[]).map((t) => ({
  plate: t.plate,
  maxPallets: t.max_pallets,
  weekday: t.weekday_rate,
  offpeak: t.offpeak_rate,
  deduction: t.daily_deduction,
  zones: t.priority_zones as string[],
  hasDriver: drivenPlates.has(t.plate),
}));

/** Trucks the auto-dispatcher can actually assign (driver-bound). Excludes "4 Wheel". */
export const DISPATCHABLE: FleetTruck[] = FLEET.filter((t) => t.hasDriver);

export function truckByPlate(plate: string): FleetTruck {
  const t = FLEET.find((x) => x.plate === plate);
  if (!t) throw new Error(`fixture: no truck ${plate}`);
  return t;
}

/** zone_code -> full destination points (deduped; K2's two location rows agree at 4). */
export const ZONE_POINTS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const d of spec.destination_points as any[]) m[d.zone_code] = d.points;
  return m;
})();

export const ZONES: string[] = (spec.zones as any[]).map((z) => z.code);

/**
 * Zone adjacency as seeded (Mr. Teh's email; mirrored in tests/dispatch.test.ts):
 * P2↔K1 and P2↔A1. Every other zone stands alone — KL is the long-haul outlier
 * with no neighbours and, notably, no truck lists it as a priority zone.
 */
export const ADJACENCY: Record<string, string[]> = {
  P1: [],
  P2: ["K1", "A1"],
  P3: [],
  K1: ["P2"],
  K2: [],
  A1: ["P2"],
  A2: [],
  KL: [],
};

/** A free (idle, full-capacity) dispatch candidate built from a fleet truck. */
export function freeCandidate(t: FleetTruck, over: Partial<TruckCandidate> = {}): TruckCandidate {
  return {
    plate: t.plate,
    driverId: `drv-${t.plate}`,
    maxPallets: t.maxPallets,
    currentLoad: 0,
    coverageZones: t.zones,
    activeZones: [],
    ...over,
  };
}

/** The whole dispatchable fleet, all idle — optionally excluding some plates (e.g. "PLX busy"). */
export function freeFleet(exclude: string[] = []): TruckCandidate[] {
  return DISPATCHABLE.filter((t) => !exclude.includes(t.plate)).map((t) => freeCandidate(t));
}

/** The incentive-engine truck shape (rates + deduction) for a plate. */
export function incTruck(plate: string) {
  const t = truckByPlate(plate);
  return {
    daily_deduction_points: t.deduction,
    entitled_claim_weekday: t.weekday,
    entitled_claim_offpeak: t.offpeak,
  };
}

/** A UTC Date for a Malaysia-time (UTC+8) wall clock — hour<8 rolls to the previous UTC day, which is fine. */
export function myt(year: number, month1to12: number, day: number, hour = 10, min = 0): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day, hour - 8, min));
}

/**
 * Anchor days. 2026-07-18 is a Saturday (verified: the repo's own commits stamp
 * "Sat Jul 18 2026", and the suite's first test re-checks it via isOffPeak), so
 * 2026-07-20 is the following Monday — a plain weekday.
 */
export const D = {
  /** Monday 2026-07-20 — a weekday. Default 10:00 MYT = peak band. */
  monday: (hour = 10, min = 0) => myt(2026, 7, 20, hour, min),
  /** Saturday 2026-07-18 — a weekend day (always off-peak). */
  saturday: (hour = 10, min = 0) => myt(2026, 7, 18, hour, min),
  /** Tuesday 2026-07-21 — the day after Monday, for midnight-straddle tests. */
  tuesday: (hour = 10, min = 0) => myt(2026, 7, 21, hour, min),
};

export const NO_HOLIDAYS: ReadonlySet<string> = new Set<string>();

/** Convenience: build a scored drop for a zone using its spec points. */
export function drop(zoneCode: string) {
  return { zoneCode, zonePoints: ZONE_POINTS[zoneCode] };
}

/**
 * Simulate one driver's whole MYT day: a sequence of trips, each a list of
 * delivered-drop zone codes. Threads priorPointsToday and zonesDeliveredEarlier
 * exactly as the route layer does, so the per-zone-per-day repeat rule and the
 * once-per-day deduction telescope across separate trips. Returns each trip's
 * engine result plus the day total — the shared engine for the payroll golden,
 * the invariant sweep, and the proof report.
 */
export function simulateDriverDay(
  plate: string,
  trips: string[][],
  date: Date,
  holidays: ReadonlySet<string> = NO_HOLIDAYS
): { perTrip: DeliveryIncentiveResult[]; total: number; dayPoints: number } {
  const truck = incTruck(plate);
  let priorPointsToday = 0;
  const delivered: string[] = [];
  const perTrip: DeliveryIncentiveResult[] = [];
  for (const zones of trips) {
    const res = calculateDeliveryIncentive({
      rateDateTime: date,
      drops: zones.map((z) => drop(z)),
      zonesDeliveredEarlierToday: [...delivered],
      priorPointsToday,
      publicHolidays: holidays,
      truck,
    });
    perTrip.push(res);
    priorPointsToday += res.pointsThisTrip;
    delivered.push(...zones);
  }
  const total = Math.round(perTrip.reduce((s, r) => s + r.incentiveThisTrip, 0) * 100) / 100;
  return { perTrip, total, dayPoints: priorPointsToday };
}

