-- Per-driver leave calendar (tracker #4): date-based dispatch availability.
-- A driver on leave for a trip's pickup MYT date is excluded from auto
-- candidates and blocked in manual approve — without touching their login
-- (the disable status revokes access entirely; leave must not).

-- CreateTable
CREATE TABLE "DriverLeave" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverLeave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriverLeave_driver_id_start_date_end_date_idx" ON "DriverLeave"("driver_id", "start_date", "end_date");

-- AddForeignKey
ALTER TABLE "DriverLeave" ADD CONSTRAINT "DriverLeave_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
