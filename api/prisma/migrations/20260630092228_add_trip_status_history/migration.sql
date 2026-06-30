-- CreateEnum
CREATE TYPE "TripEvent" AS ENUM ('booked', 'assigned', 'started', 'stop_arrived', 'stop_delivered', 'completed', 'rejected', 'cancelled', 'assigned_external', 'rerouted');

-- CreateTable
CREATE TABLE "TripStatusHistory" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "event" "TripEvent" NOT NULL,
    "stop_id" TEXT,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TripStatusHistory_trip_id_created_at_idx" ON "TripStatusHistory"("trip_id", "created_at");

-- AddForeignKey
ALTER TABLE "TripStatusHistory" ADD CONSTRAINT "TripStatusHistory_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

