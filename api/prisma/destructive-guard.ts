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
