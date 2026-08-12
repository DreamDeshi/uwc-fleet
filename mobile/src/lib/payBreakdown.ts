// Per-drop pay breakdown arithmetic. Pure module (no React Native imports) —
// unit-tested in payBreakdown.test.ts, same discipline (and same reason) as
// lib/earnings.ts: screen arithmetic that can't be asserted on is where the
// last money-display bug lived.
//
// Everything here is the SERVER'S OWN finalize-time evidence, re-arranged for
// display: per-stop `points_awarded` (pre-deduction) + `was_repeat`, the
// trip's `deduction_applied` and `rate_used`. The only client arithmetic is
// integer sums/differences of those evidence values; no RM amount is ever
// computed client-side — the RM shown next to this card is always the
// server's figure, so the two can never disagree.

import type { Trip } from "../types";

export interface BreakdownRow {
  stopId: string;
  sequence: number;
  /** Consignee company name, or null when the include was trimmed. */
  name: string | null;
  /** The engine's pre-deduction points for this drop (write-once evidence). */
  points: number;
  /** Scored as a same-zone repeat (flat 1 pt) — persisted so "why only 1?" is answerable. */
  wasRepeat: boolean;
}

export interface PayBreakdown {
  rows: BreakdownRow[];
  /** Sum of the per-drop points (pre-deduction). */
  totalPoints: number;
  /** Deduction points actually subtracted at this trip's finalization; null = not recorded (legacy). */
  deduction: number | null;
  /**
   * R5 A2 (IM10) — points HELD BACK because the day's interplant legs do not yet
   * make up whole round trips. 0 on every customer/supplier trip; null = not
   * recorded (finalized before the column).
   *
   * ⚠ THIS IS THE LINE THAT EXPLAINS RM0. Interplant is paid per completed round
   * trip, so the day's FIRST leg pays nothing and the pay lands on the return —
   * the only place in this system where a delivered, completed trip legitimately
   * earns zero. Without a line saying so, the driver's breakdown shows a
   * delivered stop worth points and a payout of RM0, which reads as the system
   * losing his money.
   */
  roundTripShortfall: number | null;
  /** totalPoints − deduction − shortfall, when the deduction was recorded. */
  payablePoints: number | null;
  /** RM per point actually paid (Decimal → number); null = not recorded (legacy). */
  rate: number | null;
}

/**
 * The trip's per-drop pay evidence, or null when none was persisted (not yet
 * finalized, or a legacy pre-feature trip) — callers render nothing then.
 */
export function buildPayBreakdown(
  trip: Pick<Trip, "stops" | "deduction_applied" | "rate_used"> & {
    round_trip_shortfall?: number | null;
  }
): PayBreakdown | null {
  const rows: BreakdownRow[] = (trip.stops ?? [])
    .filter((s) => s.points_awarded !== null && s.points_awarded !== undefined)
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => ({
      stopId: s.id,
      sequence: s.sequence,
      name: s.consignee?.company_name ?? null,
      points: s.points_awarded as number,
      wasRepeat: s.was_repeat === true,
    }));
  if (rows.length === 0) return null;

  const totalPoints = rows.reduce((sum, r) => sum + r.points, 0);
  const deduction =
    trip.deduction_applied === null || trip.deduction_applied === undefined
      ? null
      : trip.deduction_applied;
  const rateRaw = trip.rate_used;
  const rate =
    rateRaw === null || rateRaw === undefined || Number.isNaN(Number(rateRaw))
      ? null
      : Number(rateRaw);

  const shortfallRaw = trip.round_trip_shortfall;
  const roundTripShortfall =
    shortfallRaw === null || shortfallRaw === undefined ? null : shortfallRaw;

  return {
    rows,
    totalPoints,
    deduction,
    roundTripShortfall,
    // The withheld points come off the SAME total the deduction does, in the
    // same order the engine applied them (deduction first, then the halving on
    // what survives), so this figure equals what the server actually paid for.
    payablePoints:
      deduction === null ? null : totalPoints - deduction - (roundTripShortfall ?? 0),
    rate,
  };
}
