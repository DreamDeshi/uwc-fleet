-- Purely additive: six nullable columns, no defaults, no backfill — existing
-- rows untouched (pre-feature completed trips read as "breakdown not
-- recorded"). Persists the incentive engine's own finalize-time outputs so
-- the clerk can verify pay without re-running the rule by hand.
ALTER TABLE "Trip" ADD COLUMN     "rate_used" DECIMAL(10,2);
ALTER TABLE "Trip" ADD COLUMN     "off_peak" BOOLEAN;
ALTER TABLE "Trip" ADD COLUMN     "deduction_applied" INTEGER;
ALTER TABLE "TripStop" ADD COLUMN     "points_awarded" INTEGER;
ALTER TABLE "TripStop" ADD COLUMN     "was_repeat" BOOLEAN;
ALTER TABLE "TripStop" ADD COLUMN     "zone_code" TEXT;
