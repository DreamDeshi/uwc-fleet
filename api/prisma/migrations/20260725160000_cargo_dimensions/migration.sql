-- Q10 structured cargo dimensions (feet) for crate/rack/custom. Additive,
-- nullable — no other schema change. (Hand-written: `prisma migrate diff` would
-- also emit a spurious drop of the Prisma-invisible composite exception FK.)
ALTER TABLE "CargoDetail" ADD COLUMN "width_ft" DOUBLE PRECISION;
ALTER TABLE "CargoDetail" ADD COLUMN "length_ft" DOUBLE PRECISION;
