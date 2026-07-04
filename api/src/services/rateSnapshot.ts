import type { Prisma } from "@prisma/client";
import { ApiError } from "../lib/apiError";
import { effectiveZonePoints } from "./pendingRates";

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
  // Deliberately a plain copy: we want the truck's values as they stand RIGHT
  // NOW, frozen onto the trip row at the moment of assignment.
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
  // The `??` is the legacy fallback: trips assigned before the rate-lock
  // migration carry no snapshot, so they finalize at the live truck values.
  // Every trip assigned since gets its frozen rates.
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
 * The zone IDENTITY a drop is scored under at finalization: the assignment-time
 * snapshot when present, else the consignee's live zone (legacy fallback for
 * stops assigned before the identity snapshot existed).
 *
 * Without this, an admin consignee ZONE correction (PATCH /consignees/:id)
 * landing while a trip is in flight split the evidence from the pay: points
 * stayed snapshotted (old zone's value) but the day-ledger key and the
 * persisted zone_code evidence read the consignee's NEW zone — e.g. evidence
 * saying "K1 — 6 pts" when K1 is 3, and same-day repeats misclassified in
 * both directions (audit 2026-07-05 #4). Snapshotting the identity next to
 * the points makes a correction affect FUTURE bookings only — the entire
 * point of the correction feature.
 */
export function dropZoneCode(
  stop: { zone_code: string | null },
  liveZoneCode: string
): string {
  return stop.zone_code ?? liveZoneCode;
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
 * Snapshot every stop's destination-zone points AND zone identity for a
 * just-claimed trip. Runs inside the SAME transaction as the assignment claim
 * (both call sites hold a Serializable tx), and only after the claim was won —
 * losers never write. The zone_code written here is what finalization scores
 * against (ledger key + evidence), so a later consignee zone correction can
 * never split the evidence from the snapshotted points (dropZoneCode above).
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
    select: {
      zone_code: true,
      location_name: true,
      points: true,
      pending_points: true,
      pending_points_effective: true,
    },
  });
  // The points snapshotted are those EFFECTIVE right now — a staged points
  // edit is invisible until its next-MYT-day cutoff (same rule as the truck
  // claim rates above).
  const now = new Date();
  const pointsByZone = buildPointsByZone(
    rateRows.map((r) => ({ ...r, points: effectiveZonePoints(r, now) }))
  );

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
      // zone_code: the identity lock, written next to the points it explains.
      data: { zone_points: points, zone_code: s.consignee.zone_code },
    });
  }
}
