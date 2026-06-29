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

/** Component weights, summing to 100. */
export const WEIGHTS = { onTime: 40, completion: 30, points: 30 } as const;

/** Per-driver inputs, already reduced from the driver's trips by the caller. */
export interface DriverTripStats {
  /** Completed trips judged on time (see isTripOnTime). */
  onTimeCompleted: number;
  /** All completed trips (all-time). */
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

/** Day index (local) of a Date — used to compare delivery day vs pickup day. */
function localDayIndex(d: Date): number {
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / (24 * 60 * 60 * 1000)
  );
}

/**
 * On-time proxy: every stop was delivered on (or before) the same local
 * calendar day the trip was picked up — i.e. the run didn't spill into the next
 * day. No scheduled per-stop ETA is stored, so this is the best honest signal
 * of a trip that completed as planned. (Same rule as the dashboard KPI.)
 */
export function isTripOnTime(pickup: Date, stops: { delivered_at: Date | null }[]): boolean {
  const pickupDay = localDayIndex(new Date(pickup));
  return stops.every((s) => {
    if (!s.delivered_at) return true;
    return localDayIndex(new Date(s.delivered_at)) <= pickupDay;
  });
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
  const { onTimeCompleted, totalCompleted, cancelled, pointsThisMonth } = stats;

  const onTimeFraction = totalCompleted > 0 ? onTimeCompleted / totalCompleted : 0;
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
