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
  /**
   * The truck's SECOND rate pair, from the INTER PLANT block of the workbook's
   * INTERNAL LORRY RATE sheet (28 Jul revision, rows 25–31).
   *
   * A rate is a property of the WORK, not of the lorry. PLX 2406 sits in BOTH
   * workbook tables — RM11/13 as a customer/supplier lorry (row 6/16) and
   * RM6/8 for interplant (row 27/30) — which is exactly why one pair per truck
   * could not express it, and why interplant trips on PLX 2406 have been
   * paying the customer rate.
   *
   * Absent = this truck has no interplant row of its own; see
   * INTERPLANT_FALLBACK_RATE for what a cross-assigned backup lorry earns.
   */
  interplant_weekday_rate?: number;
  interplant_offpeak_rate?: number;
}

/**
 * What a lorry with NO interplant row of its own is paid for interplant work.
 *
 * Mr. Teh, R5 A3 (11 Aug 2026), asked which rate a non-interplant lorry doing a
 * plant run takes: "CHANGE TO INTERPLANT PAY". That settles that it is NOT the
 * lorry's own customer rate, but not WHICH of the two interplant rows it
 * becomes — the two differ by RM1 per point (PLX 6/8, PPE 5/7).
 *
 * OWNER RULING 11 Aug 2026: PLX 2406's pair. It is the designated primary
 * interplant lorry ("PLX 2406 will be focus on interplant delivery only",
 * email 28 Jul) and the higher of the two, so the residue falls in the
 * driver's favour. Recorded rather than re-asked (owner: no more questions).
 */
export const INTERPLANT_FALLBACK_RATE = { weekday: 6, offpeak: 8 } as const;

/** Plates AUTO dispatch must never offer for customer/supplier work. */
export const INTERPLANT_PLATES: ReadonlySet<string> = new Set(
  SPEC_TRUCKS.filter((t) => t.service_class === "interplant").map((t) => t.plate)
);

/** True for a truck the customer/supplier AUTO pool excludes. */
export function isInterplantPlate(plate: string): boolean {
  return INTERPLANT_PLATES.has(plate);
}

/**
 * True when a booking's RouteType is interplant work — the predicate that
 * selects the interplant RATE at assignment.
 *
 * Matched on the RouteType NAME because that is the only thing that
 * distinguishes the six seeded categories (Customer/Supplier/Inter-Plant ×
 * Delivery/Return); RouteType carries an id and a name and nothing else.
 * Punctuation and case are normalised away first, so "Inter-Plant Delivery",
 * "Inter Plant Return" and "InterPlant" all match — the seeded spelling is
 * hyphenated, and a future rename that keeps the words keeps the money right.
 *
 * ⚠ A rename that drops the words ENTIRELY (e.g. "Plant Transfer") would make
 * this return false and silently pay the customer rate. The RouteType names are
 * seeded, not user-editable, and tests/interplantRate.test.ts pins the two
 * seeded names against this predicate — so such a rename fails the build rather
 * than the payroll.
 */
export function isInterplantRouteType(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase().startsWith("interplant");
}

/**
 * True for a RETURN booking — cargo coming back, rather than going out.
 *
 * Used by B7's booking cut-offs, which Mr. Teh exempted in his own sentence:
 * "for return cargo from supplier / customer, they can choose pickup anytime
 * before 12am". The three seeded return types are Customer Return, Supplier
 * Return and Inter-Plant Return.
 *
 * ⚠ HE NAMED TWO; THIS EXEMPTS ALL THREE, and that is a decision. A return leg
 * is collection-driven in every case — it moves when the other site says the
 * cargo is ready, not when our dispatcher would prefer — which is the whole
 * reason he exempted returns at all. For INTERPLANT it matters more, not less:
 * pay is per completed ROUND TRIP (R5 A2), so refusing a return leg after the
 * afternoon cut-off would not merely delay a booking, it would strand the
 * outbound leg's point
 * unpaid until the next day and, if the return then lands on the following
 * calendar day, lose it entirely (IM11). Erring toward ALLOWED is the direction
 * that cannot take money off a driver for a rule whose boundary we chose.
 *
 * Matched on the same normalised NAME basis as isInterplantRouteType, and
 * pinned against the seeded names in tests/bookingCutoff.test.ts.
 */
export function isReturnRouteType(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase().endsWith("return");
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
