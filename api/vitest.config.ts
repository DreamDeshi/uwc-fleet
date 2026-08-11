import { defineConfig } from "vitest/config";

/**
 * UNIT test config (the default `npm test`).
 *
 * These are pure-logic tests — no database, no HTTP — so they run fast and need
 * no Docker. The integration suite lives in tests-integration/ and is run
 * separately (`npm run test:integration`) against the Docker test DB; it is
 * deliberately EXCLUDED here by scoping include to tests/.
 *
 * globalSetup fails the run if src/data/uwcSpecTrucks.ts is stale. It runs
 * whatever the file filter is, which is the point: a single-file run of a money
 * pin must not pass against generated data that `gen:spec` never rewrote.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./vitest.globalSetup.mjs"],
  },
});
