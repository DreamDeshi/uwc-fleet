-- Purely additive: nullable column, no default, no backfill — existing rows
-- are untouched. Mirrors 20260630181500_add_auto_dispatch_failed.
ALTER TABLE "Trip" ADD COLUMN     "auto_dispatch_note" TEXT;
