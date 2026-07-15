/**
 * Integration-suite setup — runs BEFORE any test module (and therefore before
 * the app / Prisma singleton) is imported. Two jobs:
 *
 *   1. Point DATABASE_URL at the LOCAL Docker test database, regardless of what
 *      api/.env contains. Because dotenv never overrides an already-set
 *      variable, setting it here — before app.ts runs `import "dotenv/config"` —
 *      guarantees Prisma connects to Docker even if api/.env were pointed
 *      elsewhere.
 *
 *   2. HARD SAFETY GATE: refuse to run against anything but localhost. This is
 *      the belt-and-suspenders that makes it impossible for the destructive
 *      integration suite (it truncates tables) to ever touch a remote/prod DB,
 *      even if the environment is misconfigured.
 *
 * This file intentionally imports NOTHING from src/ — env must be set first.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://uwc:uwc@localhost:55432/uwc_test?schema=public";

function assertLocalhost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`[integration] DATABASE_URL is not a valid URL: ${url}`);
  }
  const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  const prodMarkers = ["rlwy.net", "railway.internal", "railway.app"];
  if (!local.includes(host) || prodMarkers.some((m) => host.includes(m))) {
    throw new Error(
      `[integration] Refusing to run against non-local DB host "${host}". ` +
        `Integration tests TRUNCATE data — they may only target a local Docker DB ` +
        `(${local.join(", ")}). Start one with: npm run test:db:up`
    );
  }
}

assertLocalhost(TEST_DATABASE_URL);
process.env.DATABASE_URL = TEST_DATABASE_URL;

// Deterministic auth secrets so the suite doesn't depend on api/.env existing.
// (`||=` leaves any already-set value alone.)
process.env.JWT_ACCESS_SECRET ||= "integration-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "integration-test-refresh-secret";
process.env.JWT_ACCESS_EXPIRY ||= "30m";
process.env.JWT_REFRESH_EXPIRY ||= "7d";
process.env.NODE_ENV = "test";
