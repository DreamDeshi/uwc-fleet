/**
 * HOW GOOD IS A STORED PIN — the one place that reads `geocode_match_type`.
 *
 * ⚠ THIS DELIBERATELY CONTRADICTS A REASONED COMMENT, SO READ WHY FIRST.
 *
 * `schema.prisma`, `types.ts`, `geo.ts` and `earlyTap.ts` all say NEVER GATE ON
 * `geocode_match_type`, and they give a reason: the column carries FOUR
 * provider vocabularies, so a reader matching on one silently mis-handles rows
 * written by the other three. That reason is CORRECT, and it is a real defect
 * they were describing — not a style preference.
 *
 * It is an argument against AD-HOC matching, and this module is the answer to
 * it rather than a violation of it: ONE total function, enumerating every value
 * all four writers can produce, pinned by a test that fails if a vocabulary is
 * dropped. The hazard was scattered partial matches; the fix is a single
 * audited mapping, not permanent blindness to a column we wrote on purpose.
 *
 * WHY THIS IS NEEDED AT ALL. The old rule — "presence of coordinates is the
 * gate, a non-null pair is a real building" — worked because the write gate
 * threw away everything coarser. It also threw away the position of 349
 * production consignees (292 GEOMETRIC_CENTER + 57 APPROXIMATE), who then
 * navigate to their ZONE CENTROID instead: one shared dot for a whole zone,
 * and in K2 that dot is 26.94 km from Kuala Ketil. A road-level pin is wrong by
 * a street. The centroid is wrong by half an hour's driving, and we were
 * choosing it on purpose.
 *
 * So precision becomes a VALUE instead of a yes/no encoded in null-ness, and
 * each reader states which grade it needs:
 *
 *   NAVIGATION  any pin beats the centroid — use it, and say what it is.
 *   JUDGEMENT   `earlyTap` compares a driver's GPS against the stored point and
 *               puts him on an admin list if he is >500 m away. That must go on
 *               reading BUILDING pins only. Feeding it road-level pins would
 *               flag honest drivers, which is why widening the coordinate gate
 *               without this module would have quietly degraded a human signal.
 *
 * ⚠ `unknown` is not a failure — it means a writer we do not have a mapping
 * for. It is navigable (a stored coordinate is still better than a centroid)
 * and never judgeable. Do not "tidy" it into `area`: the two differ exactly in
 * what we are entitled to claim.
 */

/** How good a stored coordinate is. Absence of a coordinate is not a grade. */
export type GeocodePrecision = "building" | "road" | "area" | "unknown";

/**
 * Every value the four writers can put in `geocode_match_type`.
 *
 * Google      geocode-google.ts / geocodeConsignee.ts   (current)
 * Geoapify    the retired scripts/geocode-consignees.ts (legacy rows)
 * driver_fix  scripts/self-heal-coords.ts               (a human corrected it)
 *
 * Failure verdicts appear here too: they are stored verbatim with NULL coords,
 * so they never reach a reader as a position — but a total mapping must still
 * name them, or a future row with coords and a failure verdict maps to
 * `unknown` by accident rather than by decision.
 */
const PRECISION_BY_MATCH_TYPE: Readonly<Record<string, GeocodePrecision>> = {
  // ── Google ────────────────────────────────────────────────────────────────
  ROOFTOP: "building", // the building itself
  RANGE_INTERPOLATED: "building", // between two known street numbers — same street, right block
  GEOMETRIC_CENTER: "road", // the centre of a street segment or polyline
  APPROXIMATE: "area", // a postcode or locality centroid
  ZERO_RESULTS: "unknown",
  // ⚠ NOT a provider value — OURS. Written when GOOGLE_MAPS_KEY is absent, so
  // that a missing configuration leaves a mark instead of leaving the row
  // looking untouched. See `isBrokenAttempt`.
  NO_API_KEY: "unknown",
  ERROR: "unknown",
  RETRY_EXHAUSTED: "unknown",
  OVER_QUERY_LIMIT: "unknown",
  REQUEST_DENIED: "unknown",
  INVALID_REQUEST: "unknown",
  UNKNOWN_ERROR: "unknown",
  // ── Geoapify (legacy rows, retired script) ────────────────────────────────
  full_match: "building",
  match_by_building: "building",
  match_by_street: "road",
  match_by_postcode: "area",
  match_by_city: "area",
  // ── A human ───────────────────────────────────────────────────────────────
  // A driver stood at the gate and corrected the pin. That outranks anything a
  // provider says, so it is building-grade and IS judgeable.
  driver_fix: "building",
};

/**
 * The match types that mean BUILDING, for use as a DATABASE filter.
 *
 * Derived from the table above rather than hand-listed, so it cannot drift from
 * `geocodePrecision`. It is an OPTIMISATION, never the authority: a query using
 * it must still pass each row through `isJudgeablePin`, because a derived list
 * that came out empty would silently select nothing and read as "no rows
 * qualify" — the failure this repo keeps meeting. The test pins that it is
 * non-empty and contains ROOFTOP.
 */
export const BUILDING_MATCH_TYPES: readonly string[] = Object.entries(PRECISION_BY_MATCH_TYPE)
  .filter(([, p]) => p === "building")
  .map(([k]) => k);

/** The vocabulary this module claims to cover — the parity test reads this. */
export const KNOWN_MATCH_TYPES: readonly string[] = Object.keys(PRECISION_BY_MATCH_TYPE);

/**
 * Verdicts that mean THE LOOKUP BROKE, as opposed to the geocoder answering and
 * declining to place the address.
 *
 * The distinction is the whole point of recording them, and it is the
 * difference between two pieces of advice:
 *
 *   ZERO_RESULTS      the geocoder read the address and could not find it.
 *                     Another run returns the same answer. Fix the ADDRESS.
 *   NO_API_KEY, ERROR the lookup never reached a verdict — no key, a transport
 *   RETRY_EXHAUSTED   failure, a quota wall, a malformed query of ours.
 *   OVER_QUERY_LIMIT  Another run MIGHT work, once the cause is fixed. Fix the
 *   REQUEST_DENIED    SYSTEM.
 *   UNKNOWN_ERROR
 *   INVALID_REQUEST
 *
 * Before this existed, a broken lookup wrote NOTHING, so the row kept
 * `geocode_match_type = null` and was indistinguishable from one that had never
 * been attempted. `/consignees/coverage` counts those as "a geocode run would
 * fill it" — advice that is exactly wrong when the key is missing, because a
 * run fills none of them and the count grows every time a consignee is added.
 */
const BROKEN_ATTEMPT = new Set([
  "NO_API_KEY",
  "ERROR",
  "RETRY_EXHAUSTED",
  "OVER_QUERY_LIMIT",
  "REQUEST_DENIED",
  "UNKNOWN_ERROR",
  "INVALID_REQUEST",
]);

/** The list form, for a database filter. Non-empty by construction; pinned. */
export const BROKEN_MATCH_TYPES: readonly string[] = [...BROKEN_ATTEMPT];

/**
 * Did the lookup BREAK, rather than answer? A row with no coordinates and a
 * broken verdict needs someone to look at the system, not at the address.
 */
export function isBrokenAttempt(matchType: string | null | undefined): boolean {
  return matchType != null && BROKEN_ATTEMPT.has(matchType.trim());
}

/**
 * The grade of a stored pin. Total: every input returns a grade, and anything
 * unrecognised is `unknown` (navigable, never judgeable) rather than assumed
 * good — an unmapped writer must not be able to promote itself to `building`.
 */
export function geocodePrecision(matchType: string | null | undefined): GeocodePrecision {
  if (matchType == null) return "unknown";
  return PRECISION_BY_MATCH_TYPE[matchType.trim()] ?? "unknown";
}

/**
 * May this pin be used to JUDGE where a driver was? Building-grade only.
 *
 * This preserves the exact population `earlyTap` evaluated before road-level
 * pins existed — when a non-null pair was a real building by construction — so
 * storing coarser coordinates adds navigation without touching the admin
 * signal. `earlyTap` calls this; nothing else should need to.
 */
export function isJudgeablePin(matchType: string | null | undefined): boolean {
  return geocodePrecision(matchType) === "building";
}
