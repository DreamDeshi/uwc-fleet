-- Next-day rate cutoff (client rule, Mr. Teh 3 Jul 2026): a truck rate edit is
-- staged in pending_* columns with an effective MYT date (always tomorrow) and
-- only becomes the live rate from that day. Assignment snapshots read the rate
-- effective at assignment time; a sweep folds matured values into the base
-- columns. Nullable adds only — no backfill needed (no pending edits exist yet).

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN     "pending_claim_weekday" DECIMAL(10,2),
ADD COLUMN     "pending_claim_offpeak" DECIMAL(10,2),
ADD COLUMN     "pending_deduction_points" INTEGER,
ADD COLUMN     "pending_rates_effective" TEXT;
