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
  /** "interplant" = out of the customer/supplier AUTO pool (28 Jul 2026
   *  revision). Absent = customer/supplier. Manual admin assignment may cross
   *  the split (email pt 6) — this gates AUTO dispatch only. */
  service_class?: "interplant";
}

/** Plates AUTO dispatch must never offer for customer/supplier work. */
export const INTERPLANT_PLATES: ReadonlySet<string> = new Set(
  SPEC_TRUCKS.filter((t) => t.service_class === "interplant").map((t) => t.plate)
);

/** True for a truck the customer/supplier AUTO pool excludes. */
export function isInterplantPlate(plate: string): boolean {
  return INTERPLANT_PLATES.has(plate);
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

/**
 * Route types that are INTERPLANT — plant-to-plant, paid under Mr. Teh's
 * separate interplant scheme rather than per-zone drop points.
 *
 * Keyed on the ROUTE TYPE, not the truck. Point 6 of the 28 Jul workbook is
 * explicit that lorries cross over — "All lorry still can swap between
 * interplant and customer / supplier delivery, and also the driver assign to
 * which lorry, authorize by admin" — so `isInterplantPlate` answers a DISPATCH
 * question (which pool auto-dispatch draws from) and this answers a PAY one.
 * A customer truck lent to an interplant run is paid the interplant way, and
 * PLX 2406 lent to a customer run is paid the normal way.
 */
export const INTERPLANT_ROUTE_TYPES: ReadonlySet<string> = new Set([
  "Inter-Plant Delivery",
  "Inter-Plant Return",
]);

export function isInterplantRouteType(name: string | null | undefined): boolean {
  return name != null && INTERPLANT_ROUTE_TYPES.has(name);
}

/** The nine UWC plants an interplant booking may pick up from / deliver to (A1). */
export const UWC_PLANT_NAMES: readonly string[] = Array.from(
  { length: 9 },
  (_, i) => `UWC Plant ${i + 1}`
);

export function isUwcPlantName(companyName: string | null | undefined): boolean {
  return companyName != null && UWC_PLANT_NAMES.includes(companyName);
}
