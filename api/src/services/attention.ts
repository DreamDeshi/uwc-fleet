/**
 * Stuck-trip "attention" report (read-only) — surfaces the three states that
 * previously had NO admin visibility (the needs-attention flag only covers
 * pending trips):
 *   - in_progress far past pickup: the driver started but never finished.
 *   - assigned with pickup long past: never started (sick driver, dead phone).
 *   - completed with NULL incentive_earned: legacy anomaly from before
 *     finalization was made atomic — pay was never computed.
 *
 * Staleness is measured from pickup_datetime (started_at is not stored), so
 * "8h past pickup and still in_progress" is the honest proxy for a stalled
 * run. Thresholds are env-configurable; pure predicates so they're testable.
 */

export interface AttentionConfig {
  /** in_progress trips whose pickup is more than this many hours ago. */
  staleInProgressHours: number;
  /** assigned (never started) trips whose pickup is more than this many hours ago. */
  overdueAssignedHours: number;
}

function hoursFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function attentionConfig(): AttentionConfig {
  return {
    staleInProgressHours: hoursFromEnv("ATTENTION_STALE_INPROGRESS_HOURS", 8),
    overdueAssignedHours: hoursFromEnv("ATTENTION_OVERDUE_ASSIGNED_HOURS", 2),
  };
}

export function hoursSince(instant: Date, now: Date): number {
  return (now.getTime() - instant.getTime()) / (60 * 60 * 1000);
}

export function isStaleInProgress(
  trip: { status: string; pickup_datetime: Date },
  now: Date,
  cfg: AttentionConfig
): boolean {
  return trip.status === "in_progress" && hoursSince(trip.pickup_datetime, now) > cfg.staleInProgressHours;
}

export function isOverdueAssigned(
  trip: { status: string; pickup_datetime: Date },
  now: Date,
  cfg: AttentionConfig
): boolean {
  return trip.status === "assigned" && hoursSince(trip.pickup_datetime, now) > cfg.overdueAssignedHours;
}
