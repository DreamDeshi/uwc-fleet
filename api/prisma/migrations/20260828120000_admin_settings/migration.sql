-- Generic admin-editable settings store — see api/src/lib/settingsRegistry.ts.
--
-- PURELY ADDITIVE: one new table, no drops, no changes to any existing table.
-- Replaces several env-var-only tunables (starting with the B7 booking
-- cut-off times) with a value an admin can edit at runtime; absence of a row
-- means "use the default", so this migration changes no behaviour on its own.
--
-- ⚠ HAND-WRITTEN. Docker was not available in this environment to run
-- `prisma migrate dev`, so this file was authored by hand rather than
-- generated, following the exact style Prisma emits for `@id`/`@updatedAt` on
-- a simple model (compare AppSetting's own creation migration,
-- 20260624165829_auto_dispatch_settings/migration.sql, for the same
-- `updated_at TIMESTAMP(3) NOT NULL` — no SQL-level default; Prisma Client
-- sets it on every write). Re-run `npx prisma migrate diff` against this
-- migration once a local DB is available and confirm it reports no drift
-- before merging — see AGENTS.md, "prisma migrate diff output is a DRAFT".

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
