-- Rate lock (audit fix): snapshot the truck claim rates onto the Trip and the
-- destination-zone points onto each TripStop at ASSIGNMENT time, so an admin
-- rate edit can never change the pay of an already-dispatched (in-flight) trip.

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "entitled_claim_weekday" DECIMAL(10,2),
ADD COLUMN     "entitled_claim_offpeak" DECIMAL(10,2),
ADD COLUMN     "daily_deduction_points" INTEGER;

-- AlterTable
ALTER TABLE "TripStop" ADD COLUMN     "zone_points" INTEGER;

-- Backfill: in-flight (assigned / in_progress) trips get their snapshot from
-- the CURRENT live values — the best available stand-in for their assignment-
-- time rates. Completed trips keep their stored incentive_earned and need no
-- snapshot; pending trips are snapshotted when they are assigned.
UPDATE "Trip" AS t
SET "entitled_claim_weekday" = tr."entitled_claim_weekday",
    "entitled_claim_offpeak" = tr."entitled_claim_offpeak",
    "daily_deduction_points" = tr."daily_deduction_points"
FROM "Truck" AS tr
WHERE t."truck_plate" = tr."plate"
  AND t."status" IN ('assigned', 'in_progress');

UPDATE "TripStop" AS s
SET "zone_points" = dr."points"
FROM "Trip" AS t,
     "Consignee" AS c,
     (SELECT DISTINCT ON ("zone_code") "zone_code", "points"
        FROM "DestinationRate"
       WHERE "zone_code" IS NOT NULL
       ORDER BY "zone_code", "id") AS dr
WHERE s."trip_id" = t."id"
  AND s."consignee_id" = c."id"
  AND c."zone_code" = dr."zone_code"
  AND t."status" IN ('assigned', 'in_progress');
