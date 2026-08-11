/**
 * ONE parsing rule for every security limit that can be overridden from the
 * environment: the request limiters and the login lockout.
 *
 * The rule: a blank, missing or malformed value keeps the SAFE DEFAULT, so a
 * typo can never quietly weaken a control. Only a valid non-negative integer
 * wins, and `0` is the explicit "turn this off" value.
 *
 * ⚠ WHY IT IS SHARED RATHER THAN RESTATED, twice over. `passwordPolicy.ts`
 * carries the same warning for the same reason: two copies of a rule is how the
 * two copies drift, and a drifted SECURITY default fails open. The second
 * reason is specific to this repo — the environment knobs here have already
 * bitten once. `RATE_LIMIT_MAX=0` does NOT disable the auth limiter, because
 * that limiter reads `SENSITIVE_RATE_LIMIT_MAX`, and anyone who assumed one
 * knob governed both got a surprise. Keeping the PARSING identical is the least
 * this can do; the names still have to be looked up.
 */
export function resolveSecurityLimit(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  const parsed = trimmed ? Number(trimmed) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
