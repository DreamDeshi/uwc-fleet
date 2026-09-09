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
   * R5 A2 (IM10/IM11) — points scored but not paid at the FULL rate, because
   * interplant pays per round trip and this trip's own points didn't divide
   * evenly into one. 0 on every customer/supplier trip; null = not recorded
   * (finalized before the column). CAN BE A HALF-POINT (0.5, 1.5, …) since the
   * IM11 fix (9 Sep 2026) — see incentiveEngine's `payable` comment.
   *
   * ⚠ THIS IS THE LINE THAT EXPLAINS THE GAP between points scored and points
   * paid. Before IM11, an unpaired leg paid RM0 outright and this field
   * explained the whole amount; now every leg pays at least half, and this
   * field explains the half that round-trip pairing still discounts. Without a
   * line saying so, the driver's breakdown shows a delivered stop worth points
   * and a payout smaller than points × rate, which reads as the system losing
   * his money.
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
  trip: Pick<Trip, "stops" | "deduction_applied" | "rate_used" | "round_trip_shortfall">
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

  // Decimal-on-the-wire (IM11): the API serialises round_trip_shortfall as a
  // STRING ("0.50"), same as rate_used above — Number() it the same way, not
  // passed through raw. A shortfall that arrives as a string and is compared
  // or formatted as one elsewhere (e.g. a strict `=== 0`) would silently
  // misbehave; this is the one place that conversion happens for every caller.
  const shortfallRaw = trip.round_trip_shortfall;
  const roundTripShortfall =
    shortfallRaw === null || shortfallRaw === undefined || Number.isNaN(Number(shortfallRaw))
      ? null
      : Number(shortfallRaw);

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
