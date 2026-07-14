import { defineConfig } from "vitest/config";

/**
 * UNIT test config (the default `npm test`).
 *
 * These are pure-logic tests — no database, no HTTP — so they run fast and need
 * no Docker. The integration suite lives in tests-integration/ and is run
 * separately (`npm run test:integration`) against the Docker test DB; it is
 * deliberately EXCLUDED here by scoping include to tests/.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
