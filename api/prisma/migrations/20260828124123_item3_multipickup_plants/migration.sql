-- AlterTable
ALTER TABLE "CargoDetail" ADD COLUMN     "pickup_consignee_id" TEXT;

-- AlterTable
ALTER TABLE "Consignee" ADD COLUMN     "is_uwc_plant" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "CargoDetail" ADD CONSTRAINT "CargoDetail_pickup_consignee_id_fkey" FOREIGN KEY ("pickup_consignee_id") REFERENCES "Consignee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
