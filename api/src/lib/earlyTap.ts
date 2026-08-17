/**
 * Early-tap detection (read-only) — flags a delivery confirmation whose
 * nearest-in-time GPS fix is far from the consignee's stored coordinate, for
 * ADMIN REVIEW ONLY on GET /reports/attention.
 *
 * HARD CONSTRAINTS (by design, do not weaken):
 *   - Never blocks a delivery, never alters pay, never gates finalization —
 *     this module is only ever called from the attention report, after the
 *     fact, and returns information, not decisions.
 *   - A consignee whose pin cannot bear this weight is SKIPPED entirely
 *     (returns null, never flagged). That means BOTH coordinates present AND
 *     a BUILDING-grade pin, asked via `isJudgeablePin`.
 *
 *     ⚠ THE COORDINATE CHECK ALONE USED TO BE ENOUGH, AND IS NOT ANY MORE.
 *     While the write gate stored building grades only, "has coordinates" and
 *     "is a building" were the same statement, so this module could read
 *     null-ness and stay correct. The gate now also stores ROAD and AREA pins
 *     so drivers stop navigating to a zone centroid — which would have handed
 *     this module ~349 coarse pins to measure a driver against, at a 500 m
 *     radius, and put honest drivers on an admin list for standing at the
 *     right gate on a long street. The population evaluated here is therefore
 *     deliberately UNCHANGED by that work.
 *
 *     This is the one legitimate read of geocode_match_type, and it goes
 *     through `lib/geocodePrecision.ts` — the single total mapping over all
 *     four writer vocabularies — never an inline match here.
 *   - Absence of GPS is NOT evidence: no fix inside the window → null
 *     (cannot evaluate), never a flag.
 *
 * ⚠ INVENTED CONSTANTS — the 500 m default radius and 10 min window are OUR
 * OWN engineering choices (GPS drift, large industrial premises, and the
 * known ~1.7% suspect-ROOFTOP geocodes make a tight radius false-positive
 * prone), NOT client-specified rules. Env-tunable
 * (ATTENTION_EARLY_TAP_RADIUS_M / ATTENTION_EARLY_TAP_WINDOW_MIN),
 * registered in the root .env.example.
 */
import { haversineKm } from "./geo";
import { isJudgeablePin } from "./geocodePrecision";

export interface EarlyTapFix {
  latitude: number;
  longitude: number;
  recorded_at: Date;
}

/**
 * Distance in metres from the fix nearest in time to `deliveredAt` (within
 * ±windowMin minutes) to the consignee's stored coordinate. Null when it
 * cannot be evaluated: consignee coords missing, the pin coarser than building
 * grade, or no fix in the window.
 */
export function earlyTapDistanceM(
  deliveredAt: Date,
  fixes: EarlyTapFix[],
  consignee: { latitude: number | null; longitude: number | null; geocode_match_type?: string | null },
  windowMin: number
): number | null {
  if (consignee.latitude == null || consignee.longitude == null) return null;
  // Good enough to DRIVE to is not good enough to JUDGE by. See the note above.
  if (!isJudgeablePin(consignee.geocode_match_type)) return null;
  const windowMs = windowMin * 60 * 1000;
  let best: EarlyTapFix | null = null;
  let bestDt = Infinity;
  for (const f of fixes) {
    const dt = Math.abs(f.recorded_at.getTime() - deliveredAt.getTime());
    if (dt <= windowMs && dt < bestDt) {
      best = f;
      bestDt = dt;
    }
  }
  if (!best) return null;
  const km = haversineKm(
    { latitude: best.latitude, longitude: best.longitude },
    { latitude: consignee.latitude, longitude: consignee.longitude }
  );
  return Math.round(km * 1000);
}

/** Review-flag rule: strictly beyond the radius. Null (unevaluable) never flags. */
export function isEarlyTap(distanceM: number | null, radiusM: number): boolean {
  return distanceM != null && distanceM > radiusM;
}
