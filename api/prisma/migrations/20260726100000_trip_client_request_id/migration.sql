-- DG-T7 booking idempotency: a client-supplied request key on Trip, so a submit
-- that timed out but actually succeeded returns the ORIGINAL booking instead of
-- creating a duplicate (which, in `auto` dispatch mode, dispatches a second truck).
--
-- Purely additive: one NULLABLE column + one unique index. No backfill, no data
-- rewritten, no existing column or constraint touched.
ALTER TABLE "Trip" ADD COLUMN "client_request_id" TEXT;

-- Scoped to the requestor so a replayed key can only ever return the caller's
-- OWN booking, never another requestor's.
--
-- Postgres treats NULLs as DISTINCT in a unique index, so this constraint does
-- NOT restrict existing rows or any client too old to send a key: unlimited
-- trips per requestor may keep client_request_id NULL. It only binds once a key
-- is actually supplied.
CREATE UNIQUE INDEX "Trip_requestor_id_client_request_id_key" ON "Trip"("requestor_id", "client_request_id");
