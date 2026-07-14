-- Additive: optional requestor estimate of 4×4-pallet-equivalent space for
-- carton / "Others" cargo lines (which carry no pallet footprint by conversion).
-- Nullable; existing rows are left untouched (NULL = no estimate given).
ALTER TABLE "CargoDetail" ADD COLUMN "estimated_pallets" INTEGER;
