-- CreateIndex
CREATE INDEX "LocationLog_trip_id_recorded_at_idx" ON "LocationLog"("trip_id", "recorded_at");
