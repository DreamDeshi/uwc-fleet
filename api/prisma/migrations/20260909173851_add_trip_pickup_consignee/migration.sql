-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "pickup_consignee_id" TEXT;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_pickup_consignee_id_fkey" FOREIGN KEY ("pickup_consignee_id") REFERENCES "Consignee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
