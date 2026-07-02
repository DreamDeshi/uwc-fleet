import type { Prisma } from "@prisma/client";
import { ApiError } from "../lib/apiError";

/**
 * Rate lock (audit fix #1): the pay a trip finalizes at must be the pay it was
 * DISPATCHED at. Truck claim rates are snapshotted onto the Trip and each
 * stop's destination-zone points onto the TripStop at assignment time, inside
 * the same Serializable transaction as the claim; finalization reads the
 * snapshot. A later admin rate edit therefore affects future assignments only
 * — never an in-flight trip.
 *
 * The mapping/fallback pieces are pure so the lock behaviour is unit-testable
 * without a database (tests/rateSnapshot.test.ts).
 */

// Prisma Decimal (or a plain number in tests) — anything Number() can read.
type DecimalLike = number | { toString(): string };

/**
 * The Trip-level snapshot fields written alongside the assignment claim.
 * Field names deliberately mirror Truck's so the trip row reads as "the rates
 * this trip was assigned under".
 */
export function truckRateSnapshot(truck: {
  entitled_claim_weekday: DecimalLike;
  entitled_claim_offpeak: DecimalLike;
  daily_deduction_points: number;
}): {
  entitled_claim_weekday: DecimalLike;
  entitled_claim_offpeak: DecimalLike;
  daily_deduction_points: number;
} {
  return {
    entitled_claim_weekday: truck.entitled_claim_weekday,
    entitled_claim_offpeak: truck.entitled_claim_offpeak,
    daily_deduction_points: truck.daily_deduction_points,
  };
}

/**
 * The truck params the incentive engine finalizes with: the trip's snapshot
 * when present, else the live truck values (only trips assigned before the
 * rate-lock migration, or rows seeded directly into `assigned`, lack one).
 */
export function finalizationRateParams(trip: {
  entitled_claim_weekday: DecimalLike | null;
  entitled_claim_offpeak: DecimalLike | null;
  daily_deduction_points: number | null;
  truck: {
    entitled_claim_weekday: DecimalLike;
    entitled_claim_offpeak: DecimalLike;
    daily_deduction_points: number;
  };
}): {
  entitled_claim_weekday: number;
  entitled_claim_offpeak: number;
  daily_deduction_points: number;
} {
  return {
    entitled_claim_weekday: Number(trip.entitled_claim_weekday ?? trip.truck.entitled_claim_weekday),
    entitled_claim_offpeak: Number(trip.entitled_claim_offpeak ?? trip.truck.entitled_claim_offpeak),
    daily_deduction_points: trip.daily_deduction_points ?? trip.truck.daily_deduction_points,
  };
}

/**
 * A drop's zone points at finalization: the stop's assignment-time snapshot
 * when present, else the live DestinationRate points (legacy fallback).
 *
 * A zone with NEITHER is a configuration error in a money path — it used to
 * silently pay 1 point (so a mis-seeded KL/JH/SL zone would quietly underpay
 * an 8-point run). Now it throws ZONE_POINTS_MISSING so the trip cannot
 * finalize at wrong pay; the fix is adding the zone's DestinationRate row.
 */
export function dropZonePoints(
  stop: { zone_points: number | null },
  livePoints: number | undefined,
  zoneCode?: string
): number {
  const points = stop.zone_points ?? livePoints;
  if (points == null) {
    throw new ApiError(
      422,
      "ZONE_POINTS_MISSING",
      `Zone ${zoneCode ?? "(unknown)"} has no destination points configured — add it on the Incentive Rates page before this trip can be finalized.`
    );
  }
  return points;
}

/**
 * Per-zone points map from DestinationRate rows, built DETERMINISTICALLY: rows
 * are sorted (zone, then location name) before the last-wins Map insert, so
 * two rows sharing a zone (K2's Kuala Ketil + Sungai Petani pair) always
 * resolve the same way regardless of DB return order. The rates editor keeps
 * same-zone rows in sync, so the values should never actually diverge — this
 * makes the lookup order-independent anyway.
 */
export function buildPointsByZone(
  rows: { zone_code: string | null; location_name: string; points: number }[]
): Map<string, number> {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.zone_code ?? "").localeCompare(b.zone_code ?? "") ||
      a.location_name.localeCompare(b.location_name)
  );
  const map = new Map<string, number>();
  for (const r of sorted) {
    if (r.zone_code !== null) map.set(r.zone_code, r.points);
  }
  return map;
}

/**
 * Snapshot every stop's destination-zone points for a just-claimed trip. Runs
 * inside the SAME transaction as the assignment claim (both call sites hold a
 * Serializable tx), and only after the claim was won — losers never write.
 */
export async function snapshotStopZonePoints(
  tx: Prisma.TransactionClient,
  tripId: string
): Promise<void> {
  const stops = await tx.tripStop.findMany({
    where: { trip_id: tripId },
    select: { id: true, consignee: { select: { zone_code: true } } },
  });
  if (stops.length === 0) return;

  const zoneCodes = [...new Set(stops.map((s) => s.consignee.zone_code))];
  const rateRows = await tx.destinationRate.findMany({
    where: { zone_code: { in: zoneCodes } },
    select: { zone_code: true, location_name: true, points: true },
  });
  const pointsByZone = buildPointsByZone(rateRows);

  for (const s of stops) {
    const points = pointsByZone.get(s.consignee.zone_code);
    if (points == null) {
      // Loud, at ASSIGNMENT time: a zone without points must never be
      // snapshotted as a silent 1-point payday. Manual assign surfaces this
      // as a 422 to the admin; auto-dispatch aborts and leaves the trip
      // pending with the needs-attention flag.
      throw new ApiError(
        422,
        "ZONE_POINTS_MISSING",
        `Zone ${s.consignee.zone_code} has no destination points configured — add it on the Incentive Rates page before assigning this trip.`
      );
    }
    await tx.tripStop.update({
      where: { id: s.id },
      data: { zone_points: points },
    });
  }
}
