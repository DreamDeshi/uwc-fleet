import { defineConfig } from "vitest/config";

/**
 * INTEGRATION test config (`npm run test:integration`).
 *
 * Drives the real Express app in-process (supertest) against the Docker test
 * database. Prerequisite: `npm run test:db:up` (from the repo root) must have
 * started + migrated + seeded the container first.
 *
 * setup.ts points DATABASE_URL at the local Docker DB and HARD-REFUSES any
 * non-local host BEFORE the app/Prisma modules load. Files run serially
 * (fileParallelism: false) because they share the one database.
 */
export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.ts"],
    setupFiles: ["tests-integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
