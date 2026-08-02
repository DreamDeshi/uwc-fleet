/**
 * Safety guard for the prisma/ scripts that can delete or mass-overwrite data.
 *
 * Two levels:
 *   - assertDestructiveAllowed(script) — for scripts that DELETE data
 *     (seed-clean, seed-demo-trips). A known production host is refused
 *     outright, no override; every other target additionally requires the
 *     explicit opt-in ALLOW_DESTRUCTIVE=1.
 *   - assertNotProduction(script) — for the bootstrap seed (seed.ts), which
 *     deletes nothing but DOES overwrite truck rates/deductions/expiries from
 *     the spec on re-run. That is routine on a dev DB and never acceptable
 *     against prod by accident (it would bypass the client's next-day rate
 *     cutoff and clobber admin edits), so prod is blocked; no flag needed
 *     elsewhere.
 *
 * "Production" is detected from the DATABASE_URL hostname: any Railway
 * database host (…rlwy.net public proxy, …railway.internal private network,
 * …railway.app) is treated as the live trial DB. Local api/.env now points
 * DATABASE_URL at the Docker test DB (localhost:55432), but this guard still
 * matters: a reverted .env or a deliberate shell override could aim a seed at
 * prod. It shares its host markers with the localhost-only dev/migrate guard
 * (src/lib/dbGuard.ts).
 */
import path from "path";
import dotenv from "dotenv";

// Load api/.env explicitly (the same file Prisma Client reads), so the guard
// sees DATABASE_URL no matter which directory the script was launched from.
// dotenv never overrides an already-set shell variable, so a deliberate
// DATABASE_URL=... on the command line still wins.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PROD_HOST_MARKERS = ["rlwy.net", "railway.internal", "railway.app"];

function targetHost(script: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      `\n✖ ${script}: DATABASE_URL is not set — refusing to run against an unknown target.\n`
    );
    process.exit(1);
  }
  try {
    return new URL(url).hostname;
  } catch {
    console.error(
      `\n✖ ${script}: DATABASE_URL is not a parseable URL — refusing to run against an unknown target.\n`
    );
    process.exit(1);
  }
}

function isProductionHost(host: string): boolean {
  return PROD_HOST_MARKERS.some((marker) => host.includes(marker));
}

/** Hard gate for data-DELETING scripts: prod is always refused; everywhere else needs ALLOW_DESTRUCTIVE=1. */
export function assertDestructiveAllowed(script: string): void {
  const host = targetHost(script);
  if (isProductionHost(host)) {
    console.error(
      [
        "",
        `✖ ${script}: DATABASE_URL points at the PRODUCTION database (${host}).`,
        "  Refusing to run a destructive seed against production — set ALLOW_DESTRUCTIVE=1",
        "  AND point DATABASE_URL at a non-prod DB. There is deliberately no override for",
        "  the production host: this script permanently deletes live trial data.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
  if (process.env.ALLOW_DESTRUCTIVE !== "1") {
    console.error(
      [
        "",
        `✖ ${script}: this script permanently DELETES data (target: ${host}).`,
        "  Refusing to run without the explicit opt-in. Re-run with:",
        `    ALLOW_DESTRUCTIVE=1 npx tsx prisma/${script}.ts`,
        "",
      ].join("\n")
    );
    process.exit(1);
  }
  console.log(
    `⚠ ${script}: ALLOW_DESTRUCTIVE=1 acknowledged — target "${host}" is not a known production host. Proceeding.`
  );
}

/**
 * Gate for the SCOPED trip wipe (wipe-trips.ts) — the one destructive script
 * that MAY target production, because there is a legitimate operational reason
 * to reset trip history on the live trial DB before go-live.
 *
 * ⚠ THIS DOES NOT WEAKEN assertDestructiveAllowed, AND MUST NEVER BE USED BY
 * seed-clean.ts. That script deletes USER ACCOUNTS as well as trips, and on the
 * live database that includes the client's own requestor login — which is
 * exactly why its production refusal has no override and must keep having none.
 * The difference is scope, not appetite for risk: this script touches trip rows
 * only and cannot delete a user.
 *
 * Three independent locks, because a wipe is unrecoverable without a dump:
 *
 *  1. ALLOW_TRIP_WIPE=1        — the deliberate opt-in, same shape as elsewhere.
 *  2. CONFIRM_WIPE_HOST=<host> — for a production target ONLY, the operator must
 *     retype the exact hostname. This is the lock against the commonest and
 *     worst mistake: believing you are pointed at dev. A flag you can set from
 *     memory does not prove you know where you are aimed.
 *  3. EXPECT_TRIPS=<n>         — must equal the live trip count. An authorisation
 *     given when there were 3 trips must not silently execute against 300 a
 *     month later. This one also catches the wrong database entirely: dev and
 *     prod almost never hold the same number of trips.
 */
export function assertTripWipeAllowed(script: string, actualTrips: number): void {
  const host = targetHost(script);
  const prod = isProductionHost(host);

  const refuse = (...lines: string[]): never => {
    console.error(["", `✖ ${script}: refusing to wipe (target: ${host}).`, ...lines, ""].join("\n"));
    process.exit(1);
  };

  if (process.env.ALLOW_TRIP_WIPE !== "1") {
    refuse(
      "  This permanently DELETES every trip and its children. Re-run with:",
      `    ALLOW_TRIP_WIPE=1 ... npx tsx prisma/${script}.ts --apply`
    );
  }

  if (prod && process.env.CONFIRM_WIPE_HOST !== host) {
    refuse(
      `  Target is the PRODUCTION database (${host}).`,
      "  Retype the host to confirm you know where this is aimed:",
      `    CONFIRM_WIPE_HOST=${host}`,
      process.env.CONFIRM_WIPE_HOST
        ? `  (got "${process.env.CONFIRM_WIPE_HOST}" — does not match)`
        : "  (CONFIRM_WIPE_HOST is not set)"
    );
  }

  const expected = Number(process.env.EXPECT_TRIPS);
  if (!Number.isInteger(expected)) {
    refuse(
      `  Set EXPECT_TRIPS to the trip count you are authorising (live count is ${actualTrips}).`,
      "  This is what stops an old authorisation running against new data."
    );
  }
  if (expected !== actualTrips) {
    refuse(
      `  EXPECT_TRIPS=${expected} but the target holds ${actualTrips} trip(s).`,
      "  Either the data changed since this was authorised, or this is the wrong",
      "  database. Re-check before overriding."
    );
  }

  console.log(
    `⚠ ${script}: all locks satisfied — target "${host}"${prod ? " (PRODUCTION)" : ""}, ${actualTrips} trip(s). Proceeding.`
  );
}

/** Softer gate for the bootstrap seed: only the production host is refused. */
export function assertNotProduction(script: string): void {
  const host = targetHost(script);
  if (isProductionHost(host)) {
    console.error(
      [
        "",
        `✖ ${script}: DATABASE_URL points at the PRODUCTION database (${host}).`,
        "  Refusing to run against production: re-seeding overwrites all truck rates,",
        "  deductions and document-expiry dates immediately, bypassing the next-day",
        "  rate cutoff and any admin edits. Fix live values via the admin UI",
        "  (rate editor / reset-to-spec / document editor) or a deliberate direct DB fix.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}
