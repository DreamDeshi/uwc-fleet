-- AlterEnum
ALTER TYPE "TripEvent" ADD VALUE 'incentive_approved';

-- AlterEnum
ALTER TYPE "TripStatus" ADD VALUE 'pending_approval';

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "incentive_approved_at" TIMESTAMP(3),
ADD COLUMN     "incentive_approved_by" TEXT,
ADD COLUMN     "incentive_final" DECIMAL(10,2),
ADD COLUMN     "incentive_override_reason" TEXT;
