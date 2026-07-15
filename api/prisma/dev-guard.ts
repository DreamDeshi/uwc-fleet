/**
 * Pre-flight guard for the local Prisma commands that read/write the database
 * (`npm run prisma:migrate` → `prisma migrate dev`, `npm run prisma:studio`).
 *
 * `prisma migrate dev` is the single most dangerous local command: against the
 * live DB it can apply/generate migrations or reset the schema on drift. This
 * wrapper runs FIRST (chained with && in package.json) and aborts before Prisma
 * starts if DATABASE_URL isn't a local DB — the migrate/studio tier has no
 * legitimate reason to touch a remote host (apply migrations to prod with
 * `prisma migrate deploy` via Railway, not `migrate dev` from a laptop).
 *
 * It loads api/.env exactly like Prisma does, so it sees the same DATABASE_URL
 * the CLI will use; a deliberate shell override still wins for both. The
 * ALLOW_REMOTE_DB=1 escape hatch is honoured by checkLocalDb().
 */
import path from "path";
import dotenv from "dotenv";
import { checkLocalDb, isLocalDbHost } from "../src/lib/dbGuard";

// dotenv never overrides an already-set shell variable, so a deliberate
// DATABASE_URL=... on the command line still wins (and is still checked below).
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const context = process.argv[2] || "prisma (local)";
const result = checkLocalDb(context);
if (!result.ok) {
  console.error(`\n✖ ${result.message}\n`);
  process.exit(1);
}
const label =
  result.host && isLocalDbHost(result.host) ? "local" : "remote — ALLOW_REMOTE_DB=1";
console.log(`✓ ${context}: DATABASE_URL → ${result.host} (${label}). Proceeding.`);
