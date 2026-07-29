-- TripChangeRequest — Mr. Teh's A19 "Request Change" approval flow.
--
-- PURELY ADDITIVE: one CREATE TYPE, one CREATE TABLE, two indexes, one FK, and
-- one raw partial unique index. ZERO drops, no changes to any existing table,
-- no backfill. An existing trip is simply a trip with no change requests.
--
-- ⚠ HAND-EDITED, and it must stay hand-edited. `prisma migrate diff` emitted
-- this line, and it has been REMOVED:
--
--     ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT
--       "ExceptionEvidence_action_same_exception_fkey";
--
-- That composite FK — (action_id, exception_id) -> ExceptionAction(id,
-- exception_id) — is raw SQL from the exception hardening migration and is
-- INVISIBLE to Prisma, so every future `migrate diff` in this repo will try to
-- drop it. It enforces that a piece of evidence and the action that supplied it
-- belong to the SAME exception. Dropping it here would silently remove that
-- guarantee under a migration whose stated purpose is unrelated. ALWAYS re-read
-- generated SQL for this line before committing a migration here.

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'superseded');

-- CreateTable
CREATE TABLE "TripChangeRequest" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the dispatcher's queue (oldest pending first).
CREATE INDEX "TripChangeRequest_status_requested_at_idx" ON "TripChangeRequest"("status", "requested_at");

-- CreateIndex — one trip's request history.
CREATE INDEX "TripChangeRequest_trip_id_requested_at_idx" ON "TripChangeRequest"("trip_id", "requested_at");

-- AddForeignKey
ALTER TABLE "TripChangeRequest" ADD CONSTRAINT "TripChangeRequest_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠ RAW: at most ONE pending request per trip. Prisma cannot express a partial
-- unique index, so this is hand-written — and being invisible to Prisma it
-- causes NO drift on a future `migrate diff` (unlike the composite FK above,
-- which Prisma tries to drop because it cannot see it either).
--
-- This is the canonical guarantee behind "a newer request supersedes the older
-- one". Without it two pending rows could both be approved, into conflicting
-- bookings. The route supersedes explicitly; this index is what makes that
-- impossible to get wrong under concurrency.
CREATE UNIQUE INDEX "TripChangeRequest_one_pending_per_trip"
  ON "TripChangeRequest"("trip_id")
  WHERE "status" = 'pending';
