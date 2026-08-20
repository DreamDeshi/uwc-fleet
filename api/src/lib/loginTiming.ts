/**
 * THE PASSWORD-COMPARE COST, AND WHY AN UNKNOWN PHONE MUST STILL PAY IT.
 *
 * `POST /auth/login` answers the same sentence for an unknown phone and for a
 * known phone with the wrong password — "Phone number or password is
 * incorrect." The copy is deliberate and correct. The TIMING was not: the route
 * threw on `!user` before it ever reached `bcrypt.compare`, so an unknown phone
 * came back in a few milliseconds while a real one spent ~100ms hashing.
 *
 * That is a phone-number ORACLE, and a cheap one: a single request per guess,
 * no lockout consumed, no audit row written, and nothing in the response body
 * to distinguish the two answers. An attacker learns which numbers are UWC
 * staff without ever tripping a counter — the enumeration step that makes
 * credential stuffing worth starting.
 *
 * So the unknown-phone branch now compares against a dummy hash of the same
 * cost. The work is wasted on purpose.
 *
 * ⚠ WHAT THIS DOES NOT CLAIM. Login is not constant-time and this does not try
 * to make it so. A failed login against a REAL account also writes a lockout
 * counter, which an unknown phone does not — a few milliseconds against the
 * ~100ms bcrypt gap this closes, and well inside network jitter. The goal is to
 * remove the large, reliable, single-request signal, not to chase the last
 * microsecond.
 *
 * ⚠ TWO OTHER WAYS LOGIN ADMITS AN ACCOUNT EXISTS, BOTH KEPT ON PURPOSE:
 *   · `423 ACCOUNT_LOCKED` is only ever returned for a real account;
 *   · `403 ACCOUNT_PENDING_APPROVAL` likewise.
 * Both cost an attacker several requests against the 10/min limiter, both are
 * plainly visible in the response body rather than hidden in a stopwatch, and
 * both exist because a driver who cannot get in has to be told WHY — the dead
 * end this project keeps writing rules about. Closing them would trade a real
 * usability answer for a marginal secrecy gain. Do not "fix" them without
 * deciding that trade out loud.
 */
import bcrypt from "bcrypt";

/**
 * The cost factor for every password hash this system writes.
 *
 * ⚠ IT LIVES HERE, IN ONE PLACE, BECAUSE THE DUMMY HASH BELOW MUST MATCH IT.
 * It was previously declared twice — `routes/auth.ts` and `routes/me.ts` each
 * had their own `const BCRYPT_COST = 10`. Two copies is how a shared constant
 * drifts (`lib/passwordPolicy` exists because exactly that happened to the
 * strength floor), and here a drift would be silent AND self-defeating: raise
 * the cost in one file and the dummy compare becomes measurably cheaper than a
 * real one, reopening the oracle this module was written to close.
 */
export const BCRYPT_COST = 10;

/**
 * A real bcrypt hash, at the cost factor above, of a value nothing can present.
 *
 * DERIVED, NOT HARDCODED. A pasted `$2b$10$…` literal would keep the old cost
 * silently if `BCRYPT_COST` ever changed — the drift described above, wearing a
 * disguise. Deriving it makes the match structural instead of remembered.
 *
 * ⚠ AND DERIVED LAZILY, NOT AT MODULE LOAD. The first version of this file ran
 * `bcrypt.hashSync` at import. One hash is only ~45ms, which read as free — but
 * every module that reaches `routes/auth.ts` pays it, and the unit suite runs
 * its files in parallel workers that each pay it again while competing for the
 * same libuv threadpool that bcrypt's async calls use. Measured: the API suite
 * went from 6.97s / 1382 passing to 16.47s with three real-app tests timing out
 * at 5s. It would have cost production a blocking hash on every cold boot too.
 *
 * The promise is cached, so the work happens at most once per process. The
 * first unknown-phone request after boot pays hash + compare instead of compare
 * alone — SLOWER than steady state, never faster, so it cannot reopen the
 * oracle in the direction that matters.
 *
 * The plaintext is irrelevant: this hash is only ever compared against, and the
 * comparison's result is discarded.
 */
const DUMMY_PLAINTEXT = "no account has this password — see lib/loginTiming";

let cachedDummyHash: Promise<string> | null = null;

/** The dummy hash, computed once per process. Exported for its own test. */
export function dummyPasswordHash(): Promise<string> {
  if (!cachedDummyHash) cachedDummyHash = bcrypt.hash(DUMMY_PLAINTEXT, BCRYPT_COST);
  return cachedDummyHash;
}

/**
 * Spend the same bcrypt time a real account would have cost, and discard the
 * answer. Call this on the branch where there is NO user to compare against.
 *
 * Returns nothing on purpose — a boolean would invite a caller to treat it as
 * an authentication result.
 */
export async function burnPasswordCompare(password: string): Promise<void> {
  await bcrypt.compare(password, await dummyPasswordHash());
}
