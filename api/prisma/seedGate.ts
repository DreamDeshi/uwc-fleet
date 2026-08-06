/**
 * The pure decision behind prisma/destructive-guard.ts.
 *
 * Extracted so the guard can be TESTED. destructive-guard.ts calls
 * `process.exit(1)`, which cannot be asserted on; every rule below is decided
 * here, returned as data, and unit-tested in tests/seedGate.test.ts.
 *
 * ── The problem this file solves ────────────────────────────────────────────
 * The original guard read "production" off the DATABASE_URL hostname: any
 * Railway host (…rlwy.net, …railway.internal, …railway.app) was the live
 * database. That was correct while Railway hosted exactly one database. It
 * stops being correct the moment a SECOND Railway database exists — the SDG
 * demo instance — because the guard cannot tell the two apart and refuses to
 * seed either.
 *
 * Widening the host markers would have been the wrong fix: those markers are
 * what stand between a stray DATABASE_URL and the live trial data.
 *
 * ── What replaces it ───────────────────────────────────────────────────────
 * A Railway host is still refused BY DEFAULT. It is seedable only when TWO
 * independent locks are satisfied:
 *
 *   1. The database is NAMED as a demo database (`uwc_demo`). This is the lock
 *      that keeps production structurally unreachable: prod does not carry a
 *      demo name, so no combination of flags reaches it. Deliberately a
 *      property of the TARGET, not of the operator's intent.
 *
 *   2. CONFIRM_SEED_HOST equals the target hostname exactly. Retyping the host
 *      is what proves you know where you are aimed — the same reasoning
 *      assertTripWipeAllowed already applies with CONFIRM_WIPE_HOST: "a flag
 *      you can set from memory does not prove you know where you are aimed."
 *
 * Note what is NOT here: production's hostname. The guard never needs to know
 * it, so it is not committed to this public repo, and no production credential
 * has to be read to maintain this file. Prod is excluded by lock 1 being
 * absent, not by being named.
 *
 * Non-Railway hosts (localhost, a Docker test DB, a throwaway cloud DB) are
 * unaffected and behave exactly as before this file existed.
 */

/** Hosts that carry a live-data assumption until proven otherwise. */
export const PROD_HOST_MARKERS = ["rlwy.net", "railway.internal", "railway.app"];

/**
 * Database names that identify a disposable demo instance.
 *
 * ⚠ Adding a name here makes that database seedable and wipeable on a Railway
 * host. Only ever add a database created FOR demos. Never add the name of a
 * database that holds real deliveries.
 */
export const DEMO_DB_NAMES = ["uwc_demo"];

export interface Target {
  host: string | null;
  /** Database name from the URL path, lowercased; null when absent. */
  database: string | null;
}

/** Split a DATABASE_URL into the two things every rule below is decided on. */
export function parseTarget(url: string | undefined): Target | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "").trim();
    return { host: u.hostname, database: db ? db.toLowerCase() : null };
  } catch {
    return null;
  }
}

export function isProductionHost(host: string): boolean {
  return PROD_HOST_MARKERS.some((marker) => host.includes(marker));
}

export function isDemoDatabase(database: string | null): boolean {
  return database !== null && DEMO_DB_NAMES.includes(database);
}

export type Gate = { ok: true; note?: string } | { ok: false; lines: string[] };

/**
 * May a seed run against this target at all?
 *
 * Applies to the scripts that overwrite or delete. `script` only shapes the
 * message. `env` is passed in rather than read from process.env so the rules
 * are testable without mutating global state.
 */
export function seedGate(script: string, target: Target, env: NodeJS.ProcessEnv): Gate {
  const { host, database } = target;
  if (!host) {
    return { ok: false, lines: [`✖ ${script}: DATABASE_URL is not set or not parseable — refusing to run against an unknown target.`] };
  }

  if (!isProductionHost(host)) return { ok: true };

  // From here the target is a Railway host: live data unless it names itself
  // a demo database.
  if (!isDemoDatabase(database)) {
    return {
      ok: false,
      lines: [
        `✖ ${script}: DATABASE_URL points at a PRODUCTION database (${host}, db "${database ?? "?"}").`,
        "  Refusing. Re-seeding overwrites truck rates, deductions and document-expiry",
        "  dates immediately, bypassing the next-day rate cutoff and any admin edits.",
        "  There is no override for a live database — fix live values via the admin UI.",
        "",
        `  A Railway target is seedable ONLY when its database is named one of:`,
        `    ${DEMO_DB_NAMES.join(", ")}`,
        "  which is why this cannot be forced with a flag.",
      ],
    };
  }

  if (env.CONFIRM_SEED_HOST !== host) {
    return {
      ok: false,
      lines: [
        `✖ ${script}: target is the demo database "${database}" on ${host}.`,
        "  Retype the host to confirm you know where this is aimed:",
        `    CONFIRM_SEED_HOST=${host}`,
        env.CONFIRM_SEED_HOST
          ? `  (got "${env.CONFIRM_SEED_HOST}" — does not match)`
          : "  (CONFIRM_SEED_HOST is not set)",
      ],
    };
  }

  return { ok: true, note: `demo database "${database}" on ${host} — host confirmed` };
}
