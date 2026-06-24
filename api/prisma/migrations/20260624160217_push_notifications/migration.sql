-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "pending_alert_sent" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "expo_push_token" TEXT;
