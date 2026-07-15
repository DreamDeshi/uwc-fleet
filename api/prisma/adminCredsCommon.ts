/**
 * Shared plumbing for the two credential-admin CLIs (rotate-passwords.ts,
 * break-glass-admin.ts).
 *
 * These are the ONE class of scripts that may deliberately target production —
 * rotating the live seeded passwords, or restoring admin access when every
 * admin is locked out. So unlike the seed/dev guards (which refuse prod
 * outright), these use an INVERTED guard: a local/Docker target runs freely,
 * but a production host requires an explicit per-script opt-in. Secrets are
 * always read from the environment (never argv, so they never hit the process
 * list) and are never printed.
 */
import path from "path";
import dotenv from "dotenv";
import { dbHostOf, isProdDbHost } from "../src/lib/dbGuard";

export const BCRYPT_COST = 10;

/** Load api/.env exactly like Prisma does; a shell-set var still wins. */
export function loadApiEnv(): void {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

export function fail(script: string, msg: string): never {
  console.error(`\n✖ ${script}: ${msg}\n`);
  process.exit(1);
}

export interface Target {
  host: string;
  isProd: boolean;
}

/**
 * Resolve the DATABASE_URL host and enforce the prod opt-in. A local target
 * needs no flag; a production host requires `process.env[prodOptInEnv] === "1"`.
 * Prints the resolved target loudly either way.
 */
export function resolveTarget(script: string, prodOptInEnv: string): Target {
  const url = process.env.DATABASE_URL;
  const host = dbHostOf(url);
  if (!host) {
    fail(
      script,
      `DATABASE_URL is ${url ? "not a parseable URL" : "not set"} — refusing to run against an unknown database.`
    );
  }
  const isProd = isProdDbHost(host);
  if (isProd && process.env[prodOptInEnv] !== "1") {
    fail(
      script,
      `target host "${host}" is PRODUCTION. Refusing without an explicit opt-in — re-run with ${prodOptInEnv}=1 once you are certain.`
    );
  }
  console.log(`▸ ${script}: target ${host}${isProd ? "   ⚠ PRODUCTION" : "   (local)"}`);
  return { host, isProd };
}

// Well-known / seeded defaults a rotation must never re-introduce.
const WEAK_PASSWORDS = new Set(["password123", "password", "changeme", "admin123", "12345678"]);

/**
 * Minimal strength floor: ≥12 chars, mixed case + a digit, and not a known
 * default. Throws (exits) with a specific message so a weak secret can never be
 * written. Deliberately not draconian — it's a floor, not a policy engine.
 */
export function assertStrongPassword(pw: string, label: string, script: string): void {
  const needs: string[] = [];
  if (pw.length < 12) needs.push("at least 12 characters");
  if (!/[a-z]/.test(pw)) needs.push("a lowercase letter");
  if (!/[A-Z]/.test(pw)) needs.push("an uppercase letter");
  if (!/[0-9]/.test(pw)) needs.push("a digit");
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) needs.push("to not be a well-known/default password");
  if (needs.length) {
    fail(script, `the password for ${label} is too weak — it must have ${needs.join(", ")}.`);
  }
}
