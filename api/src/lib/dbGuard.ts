/**
 * Shared safety guard keeping LOCAL processes off any non-local database.
 *
 * Local dev — the `npm run dev` API server, `prisma migrate dev`, `prisma
 * studio` — must talk to the throwaway Docker test DB (localhost:55432), never
 * the live trial DB. Production credentials live ONLY in Railway's own service
 * env; a local process that reaches them is always an accident. This mirrors
 * the destructive-seed guard (prisma/destructive-guard.ts) and the integration
 * tier's localhost gate (tests-integration/setup.ts), sharing the same host
 * markers.
 *
 * Escape hatch: set ALLOW_REMOTE_DB=1 to deliberately point a local command at
 * a remote DB (e.g. a one-off read against prod). Same spirit as
 * ALLOW_DESTRUCTIVE=1 — you have to ask for it on purpose.
 */

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
const PROD_HOST_MARKERS = ["rlwy.net", "railway.internal", "railway.app"];

/** Hostname of a DATABASE_URL, or null if unset/unparseable. */
export function dbHostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function isLocalDbHost(host: string): boolean {
  return LOCAL_HOSTS.includes(host);
}

export function isProdDbHost(host: string): boolean {
  return PROD_HOST_MARKERS.some((m) => host.includes(m));
}

/**
 * True when this process is the real deployed backend (and therefore allowed to
 * use the production database). Railway always injects RAILWAY_* service vars
 * into the container; NODE_ENV=production is a belt-and-suspenders second
 * signal. Used ONLY by the long-running server — never by the migrate/studio
 * wrappers, which have no legitimate reason to touch a remote DB.
 */
export function isDeployedRuntime(): boolean {
  return (
    Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
        process.env.RAILWAY_PROJECT_ID ||
        process.env.RAILWAY_SERVICE_ID
    ) || process.env.NODE_ENV === "production"
  );
}

export interface LocalDbCheck {
  ok: boolean;
  host: string | null;
  message?: string;
}

/**
 * Assert DATABASE_URL (read from process.env) targets a local DB. Returns a
 * result rather than throwing/exiting, so each caller controls how it reports
 * the failure. ALLOW_REMOTE_DB=1 is an explicit opt-out.
 */
export function checkLocalDb(context: string): LocalDbCheck {
  const url = process.env.DATABASE_URL;
  const host = dbHostOf(url);
  if (host === null) {
    return {
      ok: false,
      host,
      message: `${context}: DATABASE_URL is ${
        url ? "not a parseable URL" : "not set"
      } — refusing to run against an unknown database.`,
    };
  }
  if (isLocalDbHost(host)) return { ok: true, host };
  if (process.env.ALLOW_REMOTE_DB === "1") {
    return { ok: true, host }; // deliberate, explicit override
  }
  const prod = isProdDbHost(host);
  return {
    ok: false,
    host,
    message: [
      `${context}: DATABASE_URL points at a NON-LOCAL database (${host})${
        prod ? " — this is the PRODUCTION host" : ""
      }.`,
      "  Local dev must use the Docker test DB. Start it from the repo root:",
      "    npm run test:db:up",
      "  and point api/.env DATABASE_URL at:",
      "    postgresql://uwc:uwc@localhost:55432/uwc_test?schema=public",
      "  Production credentials belong only in Railway's service env, never here.",
      "  To target a remote DB on purpose, re-run with ALLOW_REMOTE_DB=1.",
    ].join("\n"),
  };
}
