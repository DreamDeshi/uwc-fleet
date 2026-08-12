-- ONE ADDITIVE MIGRATION, THREE STATEMENTS, NO BACKFILL.
--
-- Owner-authorised 12 Aug 2026. Both columns are NULLABLE with NO DEFAULT, so
-- neither rewrites its table and neither takes more than a metadata lock:
-- adding a nullable column without a default is O(1) in Postgres 11+.
--
--   1. Trip.round_trip_shortfall  — R5 A2 / IM10. Points a trip SCORED but was
--      not PAID for, because the day's interplant legs do not yet make up whole
--      round trips. The engine has always computed this; it had nowhere to live.
--      Unblocks two things: the driver's pay breakdown can finally say WHY a
--      delivered interplant leg paid RM0, and A4 (last-trip OT) can recover a
--      trip's paid points from stored evidence instead of falling back to
--      dividing money by the rate.
--
--   2. TripException.canned_reason — C9 / IM12. WHICH canned phrase the driver
--      tapped, as a code. Mr. Teh's C9 example ("nobody at site to receive") is
--      one of these four, and the free-text `reason` beside it can never be
--      shown to a requestor. A code can.
--
-- NULL means NOT RECORDED in both cases, and is deliberately distinguishable
-- from a recorded 0 / an absent tap. Nothing is backfilled: production has
-- never finalized an interplant trip and the exception feature has never been
-- switched on, so there is nothing to reconstruct — and a guessed value would be
-- indistinguishable from a measured one afterwards.
--
-- ⚠ REMOVED FROM THE GENERATED DRAFT, deliberately:
--     ALTER TABLE "ExceptionEvidence"
--       DROP CONSTRAINT "ExceptionEvidence_action_same_exception_fkey";
-- `prisma migrate diff` emits that on every diff because the constraint is a
-- raw composite FK that Prisma cannot see, so it believes the schema does not
-- want it. It is real, it is load-bearing, and dropping it here would silently
-- delete an integrity guarantee while nobody was looking at this file for that.

-- CreateEnum
CREATE TYPE "ExceptionCannedReason" AS ENUM ('gate_locked', 'nobody_at_site', 'site_closed', 'wrong_address');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "round_trip_shortfall" INTEGER;

-- AlterTable
ALTER TABLE "TripException" ADD COLUMN     "canned_reason" "ExceptionCannedReason";
