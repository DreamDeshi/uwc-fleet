/**
 * Scheduling-conflict check at assignment (roadmap #2).
 *
 * Layered ALONGSIDE — never replacing — the one-active-trip-per-driver guard
 * (DRIVER_BUSY) and the truck overload guard. Its job is narrower and richer: a
 * candidate assignment conflicts when the SAME driver or the SAME truck is
 * already committed to another trip whose pickup falls within a configurable
 * buffer of the new pickup. It returns the offending trips so the admin can be
 * told exactly what clashes and choose to override.
 *
 * Pure (no DB, no Date.now()) so it is unit-testable; callers fetch the
 * candidate trips and pass them in. Times are compared as absolute instants, so
 * timezone never enters into it (no day-bucketing needed; if any were added it
 * would use MYT/UTC+8 explicitly per the project's time convention).
 */

// Minutes either side of the new pickup within which another trip for the same
// driver/truck counts as a conflict. Override with ASSIGNMENT_CONFLICT_BUFFER_MIN.
function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const ASSIGNMENT_CONFLICT_BUFFER_MIN = minutesFromEnv("ASSIGNMENT_CONFLICT_BUFFER_MIN", 120);
export const ASSIGNMENT_CONFLICT_BUFFER_MS = ASSIGNMENT_CONFLICT_BUFFER_MIN * 60 * 1000;

// Statuses that occupy a driver/truck for conflict purposes. (`approved` is
// included per spec even though the codebase currently flips pending→assigned
// directly.) Completed/cancelled/rejected/pending never conflict.
export const CONFLICT_STATUSES = ["approved", "assigned", "in_progress"] as const;
type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export interface ConflictCandidateTrip {
  id: string;
  status: string;
  driver_id: string | null;
  truck_plate: string | null;
  pickup_datetime: Date;
  driver?: { name: string } | null;
}

export interface SchedulingConflict {
  tripId: string;
  driverOrTruck: "driver" | "truck";
  plateOrDriverName: string;
  pickup: string; // ISO 8601
}

/**
 * Find every trip in `candidates` that conflicts with assigning (driver, truck)
 * to a trip at `pickupDateTime`. A candidate X conflicts when:
 *   - X.id !== newTripId
 *   - X.status ∈ {approved, assigned, in_progress}
 *   - X shares the driver OR the truck
 *   - |X.pickup − pickup| < buffer
 * When both driver and truck match (the usual 1:1 case) it is reported once,
 * labelled by driver.
 */
export function findSchedulingConflicts(params: {
  newTripId: string | null;
  driverId: string;
  truckPlate: string;
  pickupDateTime: Date;
  candidates: ConflictCandidateTrip[];
  bufferMs?: number;
}): SchedulingConflict[] {
  const bufferMs = params.bufferMs ?? ASSIGNMENT_CONFLICT_BUFFER_MS;
  const pickupMs = params.pickupDateTime.getTime();
  const statuses = new Set<string>(CONFLICT_STATUSES as readonly string[]);
  const conflicts: SchedulingConflict[] = [];

  for (const x of params.candidates) {
    if (params.newTripId && x.id === params.newTripId) continue;
    if (!statuses.has(x.status)) continue;
    const driverClash = x.driver_id != null && x.driver_id === params.driverId;
    const truckClash = x.truck_plate != null && x.truck_plate === params.truckPlate;
    if (!driverClash && !truckClash) continue;
    if (Math.abs(x.pickup_datetime.getTime() - pickupMs) >= bufferMs) continue;

    conflicts.push({
      tripId: x.id,
      driverOrTruck: driverClash ? "driver" : "truck",
      plateOrDriverName: driverClash
        ? (x.driver?.name ?? params.driverId)
        : (x.truck_plate ?? params.truckPlate),
      pickup: x.pickup_datetime.toISOString(),
    });
  }
  return conflicts;
}

// Re-exported for callers building the DB prefilter window.
export type { ConflictStatus };
