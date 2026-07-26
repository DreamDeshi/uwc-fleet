-- K2 (Borang K2) customs form: driver uploads the actual document for a K2-zone
-- stop (Mr. Teh R1 Q6). Additive, nullable — served via the authenticated
-- Cloudinary pipeline like pod_photo. No FK/table/enum change.
ALTER TABLE "TripStop" ADD COLUMN "k2_photo" TEXT;
ALTER TABLE "TripStop" ADD COLUMN "k2_public_id" TEXT;
