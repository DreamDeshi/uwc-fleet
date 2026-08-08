import type { RouteType } from "../types";

/**
 * The booking form's "Route Type" + "Direction" controls, derived from the
 * SEEDED route-type names — not from any new field.
 *
 * `docs/uwc-spec.json` seeds exactly six route types, and every one of them is
 * a {family} × {direction} pair:
 *
 *   Customer Delivery    Supplier Delivery    Inter-Plant Delivery
 *   Customer Return      Supplier Return      Inter-Plant Return
 *
 * The requestor design splits that single six-way choice into a three-way
 * family control and a two-way direction toggle, then echoes the resolved name
 * back ("✓ Customer Delivery"). This module is the whole of that mapping: the
 * form still submits `route_type_id` from the server's own list, so nothing
 * about dispatch, rates or the API changes — only how the choice is presented.
 *
 * ⚠ The server list is authoritative, NOT this file's vocabulary. A route type
 * whose name doesn't decompose (an admin adds "Ad-hoc Charter") is NOT dropped:
 * it lands in `unmatched` and the form renders it as a plain chip. Silently
 * hiding a bookable route type would make trips unbookable with no visible
 * cause — the same class of failure as the empty route-type grid DG-R8 fixed.
 */

export type RouteFamily = "customer" | "supplier" | "interplant";
export type RouteDirection = "delivery" | "return";

/** Display order — commonest first, matching the design's chip order. */
export const ROUTE_FAMILIES: readonly RouteFamily[] = ["customer", "supplier", "interplant"];
/** Delivery first: outbound is the overwhelmingly common case. */
export const ROUTE_DIRECTIONS: readonly RouteDirection[] = ["delivery", "return"];

export interface RouteTypeChoice {
  id: string;
  name: string;
  family: RouteFamily;
  direction: RouteDirection;
}

export interface RouteMatrix {
  /** Route types whose name decomposed into a family + direction. */
  choices: RouteTypeChoice[];
  /** Route types that did not — rendered as standalone chips, never hidden. */
  unmatched: RouteType[];
}

/**
 * Decompose one route-type name. Matching is deliberately loose on separators
 * and case ("Inter-Plant", "inter plant", "InterPlant" all read the same) but
 * strict about the two halves being present: a name that carries no direction
 * word is left unmatched rather than defaulted to "delivery", because guessing
 * the direction of a return trip would pick the wrong rate lane on the board.
 */
export function parseRouteTypeName(
  name: string
): { family: RouteFamily; direction: RouteDirection } | null {
  const norm = name.toLowerCase().replace(/[\s_-]+/g, "");
  const direction: RouteDirection | null = norm.includes("delivery")
    ? "delivery"
    : norm.includes("return")
      ? "return"
      : null;
  if (!direction) return null;
  const family: RouteFamily | null = norm.startsWith("customer")
    ? "customer"
    : norm.startsWith("supplier")
      ? "supplier"
      : norm.startsWith("interplant")
        ? "interplant"
        : null;
  if (!family) return null;
  return { family, direction };
}

export function buildRouteMatrix(routeTypes: RouteType[]): RouteMatrix {
  const choices: RouteTypeChoice[] = [];
  const unmatched: RouteType[] = [];
  for (const rt of routeTypes) {
    const parsed = parseRouteTypeName(rt.name);
    if (parsed) choices.push({ id: rt.id, name: rt.name, ...parsed });
    else unmatched.push(rt);
  }
  return { choices, unmatched };
}

/** Families the server actually offers, in display order. */
export function availableFamilies(matrix: RouteMatrix): RouteFamily[] {
  return ROUTE_FAMILIES.filter((f) => matrix.choices.some((c) => c.family === f));
}

/** Directions offered for a family — a family with only one is still valid. */
export function availableDirections(matrix: RouteMatrix, family: RouteFamily): RouteDirection[] {
  return ROUTE_DIRECTIONS.filter((d) =>
    matrix.choices.some((c) => c.family === family && c.direction === d)
  );
}

export function findRouteType(
  matrix: RouteMatrix,
  family: RouteFamily,
  direction: RouteDirection
): RouteTypeChoice | undefined {
  return matrix.choices.find((c) => c.family === family && c.direction === direction);
}

/** The family/direction a stored `route_type_id` corresponds to (edit + rebook). */
export function choiceForId(matrix: RouteMatrix, id: string | undefined): RouteTypeChoice | undefined {
  return id ? matrix.choices.find((c) => c.id === id) : undefined;
}

/**
 * Keep a family + direction pair valid after the family changes.
 *
 * Directions are NOT guaranteed symmetric across families — the server owns the
 * list — so switching family while "Return" is selected can land on a pair that
 * has no route type. Falling back to the family's first available direction
 * keeps the form on a real, submittable route type instead of silently holding
 * an id-less selection that only fails at Next.
 */
export function resolveDirection(
  matrix: RouteMatrix,
  family: RouteFamily,
  preferred: RouteDirection
): RouteDirection | undefined {
  const available = availableDirections(matrix, family);
  if (available.length === 0) return undefined;
  return available.includes(preferred) ? preferred : available[0];
}
