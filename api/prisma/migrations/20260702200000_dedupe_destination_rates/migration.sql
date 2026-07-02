-- Dedupe the accidental DestinationRate twins left by an older seed's
-- location_name mismatch ("Penang" vs "Penang Island" etc). Twin rows for the
-- SAME zone are a latent money bug: the points lookup builds a per-zone map
-- with last-row-wins in arbitrary order, so if an admin edited one twin the
-- effective points became a coin flip.
--
-- Only the known stale names are removed, and each only when another row for
-- the same zone survives — so a database that has just the canonical rows is
-- untouched, and K2's two LEGITIMATE locations (Kuala Ketil + Sungai Petani,
-- one zone, per the spec sheet) are preserved.
DELETE FROM "DestinationRate" d
WHERE d."location_name" IN ('Penang Island', 'Juru & Perai (SPS, SPT)', 'Tasek Gelugor (SPU)')
  AND d."zone_code" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "DestinationRate" o
    WHERE o."zone_code" = d."zone_code" AND o."id" <> d."id"
  );

-- Align any same-zone rows whose points diverged (defensive: none known today)
-- to the zone's minimum, so the app-level zone-sync invariant starts clean.
UPDATE "DestinationRate" d
SET "points" = sub.min_points
FROM (
  SELECT "zone_code", MIN("points") AS min_points
  FROM "DestinationRate"
  WHERE "zone_code" IS NOT NULL
  GROUP BY "zone_code"
) sub
WHERE d."zone_code" = sub."zone_code"
  AND d."points" <> sub.min_points;
