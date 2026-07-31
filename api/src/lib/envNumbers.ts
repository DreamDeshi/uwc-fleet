/**
 * Reading a tunable NUMBER out of the environment, once.
 *
 * These two helpers were each defined privately in several modules with
 * byte-identical bodies — `minutesFromEnv` three times (exceptionAlerts,
 * pendingTripAlerts, schedulingConflict) and `numEnv` twice
 * (consolidationSavings, rightSizingSavings). Nothing related the copies, so a
 * fix to one would have left the others alone.
 *
 * Small and dull is exactly why it happened, and exactly why it is worth
 * collecting: the risk is not that someone edits the arithmetic, it is that
 * someone TIGHTENS one copy — rejects 0, trims whitespace, accepts a float —
 * and the operator then sets the same variable for two features and gets two
 * answers.
 *
 * They are kept SEPARATE, not merged, because they genuinely differ and the
 * difference is deliberate: see each doc comment.
 */

/**
 * A positive INTEGER number of minutes, or the fallback.
 *
 * Integer-only because every caller is a minute threshold on a background job
 * (alert ages, the scheduling-conflict buffer), where a fractional minute is
 * far more likely to be a typo than an intention. Blank and whitespace are
 * treated as unset, so `FOO=` in a .env file means "use the default" rather
 * than `Number("") === 0` silently disabling the threshold.
 */
export function minutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * A NON-NEGATIVE integer number of minutes, or the fallback. ZERO IS VALID.
 *
 * ⚠ THIS IS A DIFFERENT RULE FROM minutesFromEnv, AND IT USED TO SHARE ITS NAME.
 *
 * services/operatingWindow had a fourth private `minutesFromEnv` whose only
 * difference was `n >= 0` instead of `n > 0`. Same name, same signature, same
 * five lines — and a materially different answer for `0`.
 *
 * The difference is correct and deliberate. `OP_LOAD_MIN=0` is a real
 * configuration (a site with no loading time); under the `> 0` rule it would
 * silently fall back to 30 minutes, and those constants feed the estimated
 * completion that decides a 409 OPERATING_WINDOW on assignment. Folding the two
 * together while collecting the duplicates would have introduced a dispatch bug
 * in the act of removing a duplicate.
 *
 * So the rules stay separate and the NAMES now differ, which is the actual fix:
 * two behaviours that share an identifier are the trap, not two behaviours.
 */
export function nonNegativeMinutesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * A positive FINITE number, or the fallback. Floats allowed.
 *
 * Distinct from minutesFromEnv on purpose: the sustainability estimate
 * constants are physical quantities — litres per 100 km, kg CO2e per litre
 * (2.68) — where a non-integer is the normal case, not a typo.
 *
 * ⚠ Rejects 0 as well as negatives, so an estimate factor cannot be zeroed out
 * of the KPI by configuration alone. That is the existing behaviour of both
 * copies, preserved deliberately rather than tidied.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
