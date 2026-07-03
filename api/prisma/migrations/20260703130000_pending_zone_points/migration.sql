-- Next-day cutoff for ZONE POINTS (extends the client's Q4 rate rule, 3 Jul
-- 2026): a destination-points edit is staged here and takes effect from
-- pending_points_effective (MYT "YYYY-MM-DD" = tomorrow) — same pattern as
-- Truck.pending_*. Assignment snapshots read the points effective at
-- assignment time; the maturation sweep folds matured values into `points`.
-- Nullable adds only — no backfill needed.

-- AlterTable
ALTER TABLE "DestinationRate" ADD COLUMN     "pending_points" INTEGER,
ADD COLUMN     "pending_points_effective" TEXT;
