-- Geocoded consignee positions (Geoapify, populated offline by
-- api/scripts/geocode-consignees.ts).
--
-- Purely ADDITIVE: three nullable columns, no existing column or constraint is
-- touched, no data is rewritten. A consignee with NULL coordinates behaves
-- exactly as it does today (destination falls back to its zone centroid), so
-- this migration is a no-op for every existing code path until something opts
-- in to reading the columns.
--
-- geocode_match_type stores Geoapify's match_type verbatim and is the quality
-- GATE: only 'full_match' and 'match_by_street' are real building/street
-- positions. 'match_by_postcode' means the address was NOT resolved and the
-- point is a postcode centroid — callers must treat it as no geocode.
-- Geoapify's `confidence` is deliberately NOT stored (it reports 1.00 on
-- postcode centroids; match_type is the honest field).

-- AlterTable
ALTER TABLE "Consignee" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "geocode_match_type" TEXT;
