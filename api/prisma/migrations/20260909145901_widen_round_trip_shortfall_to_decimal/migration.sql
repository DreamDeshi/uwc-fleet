/*
  Warnings:

  - You are about to alter the column `round_trip_shortfall` on the `Trip` table. The data in that column could be lost. The data in that column will be cast from `Integer` to `Decimal(10,2)`.

*/
-- Widening Int -> Decimal(10,2), not narrowing: no truncation risk. The
-- "data could be lost" warning above is Prisma's generic template for any
-- ALTER COLUMN TYPE; it does not know this column has never held a non-null
-- value in production (see the column's own comment in schema.prisma) — there
-- is nothing to lose. Needed by the IM11 fix: round-trip halving pays
-- points/2 with no floor, so a lone/unpaired leg's shortfall is a genuine
-- half-point (0.5), which an Int column cannot hold.
ALTER TABLE "Trip" ALTER COLUMN "round_trip_shortfall" SET DATA TYPE DECIMAL(10,2);
