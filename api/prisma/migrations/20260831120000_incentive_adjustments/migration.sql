-- CreateTable
CREATE TABLE "IncentiveAdjustment" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "delta" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_month" TEXT NOT NULL,

    CONSTRAINT "IncentiveAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncentiveAdjustment_trip_id_idx" ON "IncentiveAdjustment"("trip_id");

-- CreateIndex
CREATE INDEX "IncentiveAdjustment_effective_month_idx" ON "IncentiveAdjustment"("effective_month");

-- AddForeignKey
ALTER TABLE "IncentiveAdjustment" ADD CONSTRAINT "IncentiveAdjustment_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveAdjustment" ADD CONSTRAINT "IncentiveAdjustment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
