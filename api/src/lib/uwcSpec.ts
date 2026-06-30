/**
 * Authoritative spec truck data for the API.
 *
 * The canonical source is `docs/uwc-spec.json` (the SAME file `prisma/seed.ts`
 * reads). But that file lives at the repo root, OUTSIDE the API build scope —
 * Railway builds the API with Root Directory = `/api`, so `docs/` is not present
 * in the deployed container and cannot be read at runtime (an earlier fs-based
 * loader 500'd with SPEC_NOT_FOUND in prod).
 *
 * Fix: the truck values are compiled into `data/uwcSpecTrucks.ts` (generated from
 * docs/uwc-spec.json via `npm run gen:spec`) so they ALWAYS ship inside `dist/`.
 * `tests/specSync.test.ts` asserts the generated values still match
 * docs/uwc-spec.json, so reset-to-spec and a fresh seed can never diverge.
 *
 * `UWC_SPEC_PATH` (optional) overrides with a JSON file at runtime — an ops
 * escape hatch; if unset or unreadable we use the bundled values.
 */
import fs from "fs";
import { SPEC_TRUCKS } from "../data/uwcSpecTrucks";

// Shape of a truck entry in docs/uwc-spec.json (the rate fields use the spec's
// own column names; seed.ts maps them to the DB columns the same way).
export interface SpecTruck {
  plate: string;
  type: string;
  max_pallets: number;
  weekday_rate: number;
  offpeak_rate: number;
  daily_deduction: number;
  priority_zones: string[];
}

/**
 * The authoritative truck list. Returns the bundled spec values (always present
 * in the container); honours UWC_SPEC_PATH if it points at a readable JSON file.
 * Never throws for a missing file — the bundled data is the guaranteed fallback.
 */
export function loadSpecTrucks(): SpecTruck[] {
  const override = process.env.UWC_SPEC_PATH;
  if (override) {
    try {
      const spec = JSON.parse(fs.readFileSync(override, "utf-8")) as { trucks?: SpecTruck[] };
      if (Array.isArray(spec.trucks) && spec.trucks.length > 0) return spec.trucks;
    } catch {
      // Unreadable/malformed override → fall back to the bundled values.
    }
  }
  return SPEC_TRUCKS;
}
