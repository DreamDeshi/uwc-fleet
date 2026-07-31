/**
 * Driver performance score — Development Brief FR-FM7.
 *
 * Pure (no DB, no Date.now()) so the whole calculation is unit-testable in
 * isolation. The users route is responsible for fetching each driver's trips,
 * reducing them to the per-driver counts below, and passing them in.
 *
 * Score out of 100 = three weighted components:
 *   - On-time rate (40%) — completed trips that ran on time / all completed.
 *   - Completion rate (30%) — completed / (completed + cancelled) assigned.
 *   - Incentive points (30%) — this driver's month incentive, normalised
 *     against the highest-earning driver this month (best driver → full 30).
 *
 * "Points" here is the month's summed incentive_earned (RM) — the only earnings
 * figure the schema stores per trip. Because the component is purely relative
 * (proportional to the top driver), using RM rather than raw points gives the
 * same ranking.
 */

import { mytDayIndex } from "./myt";

/** Component weights, summing to 100. */
export const WEIGHTS = { onTime: 40, completion: 30, points: 30 } as const;

/** Per-driver inputs, already reduced from the driver's trips by the caller. */
export interface DriverTripStats {
  /** Completed trips judged on time (see isTripOnTime). Subset of
   *  fullyDeliveredCompleted — a trip that did not fully deliver is not
   *  eligible to be on time. */
  onTimeCompleted: number;
  /** THE ON-TIME DENOMINATOR: completed trips where every stop was delivered
   *  (see isFullyDelivered). NOT the same as totalCompleted — see the note on
   *  isTripOnTime for why an aborted run is excluded from both sides. */
  fullyDeliveredCompleted: number;
  /** All completed trips (all-time) — the COMPLETION-rate numerator, and the
   *  "has this driver any history" signal. Deliberately still counts a
   *  partially-delivered abort: the trip did reach `completed`. */
  totalCompleted: number;
  /** Cancelled trips assigned to this driver (all-time). */
  cancelled: number;
  /** Sum of incentive_earned for this driver's trips in the current MYT month. */
  pointsThisMonth: number;
}

export interface ScoreBreakdown {
  /** On-time percentage of completed trips (0–100, 1 dp). */
  on_time_rate: number;
  /** Completion percentage of assigned (completed + cancelled) trips (0–100, 1 dp). */
  completion_rate: number;
  /** Month incentive total used for the normalised points component. */
  points_this_month: number;
  /** On-time contribution to the total (0–40, 1 dp). */
  on_time_component: number;
  /** Completion contribution to the total (0–30, 1 dp). */
  completion_component: number;
  /** Normalised points contribution to the total (0–30, 1 dp). */
  points_component: number;
  /** Final score out of 100, rounded to 1 dp. */
  total_score: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * On-time proxy: every stop was delivered on (or before) the same MYT
 * calendar day the trip was picked up — i.e. the run didn't spill into the
 * next day. No scheduled per-stop ETA is stored, so this is the best honest
 * signal of a trip that completed as planned. (Day binning is explicit MYT via
 * lib/myt.ts, never server-local.)
 *
 * ── AN UNDELIVERED STOP IS NOT ON TIME ─────────────────────────────────────
 *
 * This used to `return true` for a stop with no `delivered_at`, on the reading
 * "not delivered YET". That reading is wrong at the only place this is called:
 * routes/users.ts asks it about `status === "completed"` trips ONLY. On a
 * completed trip a null delivery is not "yet" — it is NEVER.
 *
 * And completed trips really do carry them. The 28 Jul partial-pay abort
 * finalizes to `pending_approval` with the unreached stops left `pending`, and
 * approval makes that trip `completed`. So a three-stop run that delivered one
 * drop before the lorry broke down scored a clean on-time tick on the strength
 * of two stops nobody ever drove to — the driver's own My Stats score, and the
 * admin's driver table, both flattered by an abandoned run.
 *
 * ── AND IT IS EXCLUDED FROM THE DENOMINATOR TOO (owner ruling, 31 Jul 2026) ──
 *
 * PR #77 fixed only the numerator and left FR-FM7's "/ all completed" denominator
 * as written, flagging the alternative rather than taking it. That left the two
 * surfaces DISAGREEING about a driver-visible number:
 *
 *   /reports/dashboard      excluded aborted trips from the set entirely
 *   /users/me/performance   kept them in the denominator, always late
 *
 * A driver with one clean run and one breakdown read 100% on the admin's
 * dashboard and 50% on his own My Stats. Two definitions of one metric is the
 * defect; which definition wins is the smaller question.
 *
 * THE DASHBOARD'S READING WINS. An aborted run is not evidence about punctuality
 * in EITHER direction — the driver never got the chance to be late. Counting it
 * against him charges a lorry breakdown to his score, permanently, on the number
 * that sets his Gold/Silver/Bronze tier; Mr. Teh already docks the PAY for a
 * breakdown ("if the lorry breakdown halfway, no incentive"), which is about
 * work done, not blame. And FR-FM7's "all completed" was written BEFORE the
 * partial-abort path existed (28 Jul 2026), so it is not a considered answer to
 * this case — it is a phrase from before the case was possible.
 *
 * `totalCompleted` is deliberately NOT changed: it still counts the abort, so
 * COMPLETION rate is untouched. Only the on-time denominator narrows. Those are
 * two different questions and conflating them would be the same mistake as
 * ADJUDICATED-vs-SETTLED in services/undeliveredPay.
 */

/**
 * Every stop delivered — the ON-TIME DENOMINATOR's membership test, and the
 * precondition for isTripOnTime returning true at all.
 *
 * Keyed on `delivered_at`, not `status`, because both callers already have it
 * and because the legacy anomaly (status `delivered` with a NULL delivered_at,
 * surfaced by /reports/attention) genuinely CANNOT be judged for punctuality —
 * there is no instant to compare. Excluding it is the honest answer; it used to
 * be counted as on time on the strength of a missing field.
 */
export function isFullyDelivered(stops: { delivered_at: Date | null }[]): boolean {
  return stops.length > 0 && stops.every((s) => s.delivered_at != null);
}

export function isTripOnTime(pickup: Date, stops: { delivered_at: Date | null }[]): boolean {
  if (!isFullyDelivered(stops)) return false;
  const pickupDay = mytDayIndex(new Date(pickup));
  return stops.every((s) => mytDayIndex(new Date(s.delivered_at as Date)) <= pickupDay);
}

/**
 * Compute the full score breakdown for one driver.
 *
 * @param stats               this driver's reduced trip counts
 * @param maxPointsThisMonth  the highest pointsThisMonth across ALL drivers
 *                            (the normalisation denominator). When every driver
 *                            earned nothing this month, the points component is 0.
 */
export function computeScore(stats: DriverTripStats, maxPointsThisMonth: number): ScoreBreakdown {
  const { onTimeCompleted, fullyDeliveredCompleted, totalCompleted, cancelled, pointsThisMonth } = stats;

  // The on-time denominator is FULLY-DELIVERED completions, not all of them —
  // see the ruling on isTripOnTime. A driver whose only trip was aborted has an
  // empty denominator, which is 0%, the same as before and for a better reason:
  // there is nothing to judge, not a failure to be punctual.
  const onTimeFraction = fullyDeliveredCompleted > 0 ? onTimeCompleted / fullyDeliveredCompleted : 0;
  const assigned = totalCompleted + cancelled;
  const completionFraction = assigned > 0 ? totalCompleted / assigned : 0;
  const pointsFraction = maxPointsThisMonth > 0 ? pointsThisMonth / maxPointsThisMonth : 0;

  const on_time_component = round1(onTimeFraction * WEIGHTS.onTime);
  const completion_component = round1(completionFraction * WEIGHTS.completion);
  const points_component = round1(pointsFraction * WEIGHTS.points);

  return {
    on_time_rate: round1(onTimeFraction * 100),
    completion_rate: round1(completionFraction * 100),
    points_this_month: round1(pointsThisMonth),
    on_time_component,
    completion_component,
    points_component,
    total_score: round1(on_time_component + completion_component + points_component),
  };
}

// ── Tier & percentile band (driver-facing "My Performance" view) ───────────
// These power the per-driver self view. They take only the driver's own score
// plus the anonymous spread of every driver's score — no names or peer numbers
// pass through, so the result is safe to return to the driver endpoint.

export type PerformanceTier = "Gold" | "Silver" | "Bronze";

/** Tier from a total score: Gold ≥ 75, Silver 50–74, Bronze < 50. */
export function tierForScore(totalScore: number): PerformanceTier {
  if (totalScore >= 75) return "Gold";
  if (totalScore >= 50) return "Silver";
  return "Bronze";
}

/**
 * Anonymous quartile band describing where `score` sits among `allScores` (the
 * whole fleet, this driver included). Higher score = better. The band is keyed
 * off the fraction of drivers scoring strictly higher:
 *   none above   → "top 25%"   (you're in the best quarter)
 *   < 50% above  → "top 50%"
 *   < 75% above  → "top 75%"
 *   otherwise    → "bottom 25%"
 *
 * Returns only the band string — never a name or another driver's number.
 */
export function percentileBand(score: number, allScores: number[]): string {
  const total = allScores.length;
  if (total === 0) return "top 25%";
  const fractionAbove = allScores.filter((s) => s > score).length / total;
  if (fractionAbove < 0.25) return "top 25%";
  if (fractionAbove < 0.5) return "top 50%";
  if (fractionAbove < 0.75) return "top 75%";
  return "bottom 25%";
}
