import { ApiError } from "../lib/apiError";
import { isInterplantRouteType, isUwcPlantName } from "../lib/uwcSpec";

/**
 * INTERPLANT BOOKING CONSTRAINT — Mr. Teh, A4 (29 Jul 2026):
 *
 *   "Please ensure Interplant can only select pickup point and delivery point
 *    from UWC Plant 1 to UWC Plant 9."
 *
 * and the 28 Jul workbook, point 7:
 *
 *   "Interplant delivery, requestor can only select the pickup and delivery
 *    point from P1 to P9 which is UWC in batu Kawan area, not for other
 *    customer / supplier entities"
 *
 * Kept pure — no Prisma, no clock — so every branch is unit-tested. Both booking
 * paths (create, and the shared edit/change-request validator) call it with
 * consignees they have already loaded, so it costs no extra query.
 *
 * ⚠ P1–P9 ARE CONSIGNEE NAMES, NOT ZONES (A1: "P1 to P9 is not the zone area, is
 * the consignee name"). All nine sit in zone P2 alongside Juru and Perai, so a
 * zone check would wrongly admit any Juru customer — the name is the identity.
 *
 * ⚠ BOTH DIRECTIONS ARE ENFORCED. An interplant trip must be plant-to-plant, AND
 * a customer/supplier trip must NOT carry a plant pickup point. Without the
 * second half a requestor could set a pickup on an ordinary booking and quietly
 * get the flat interplant rate applied to a customer run — or, worse, not get it
 * and be left wondering why the field did nothing.
 */
export function assertInterplantBooking(params: {
  routeTypeName: string | null | undefined;
  /** Resolved pickup consignee, or null when the booking did not name one. */
  pickupConsignee: { company_name: string } | null;
  /** Resolved consignees for the stops, IN STOP ORDER. */
  stopConsignees: { company_name: string }[];
}): void {
  const interplant = isInterplantRouteType(params.routeTypeName);

  if (!interplant) {
    if (params.pickupConsignee) {
      throw new ApiError(
        400,
        "PICKUP_POINT_NOT_ALLOWED",
        "A pickup point can only be chosen for an Inter-Plant booking. Customer and supplier trips are collected at UWC."
      );
    }
    return;
  }

  if (!params.pickupConsignee) {
    throw new ApiError(
      400,
      "PICKUP_POINT_REQUIRED",
      "An Inter-Plant booking must name the UWC plant the cargo is collected from."
    );
  }
  if (!isUwcPlantName(params.pickupConsignee.company_name)) {
    throw new ApiError(
      400,
      "PICKUP_POINT_NOT_A_PLANT",
      `An Inter-Plant booking can only be collected from UWC Plant 1–9 — "${params.pickupConsignee.company_name}" is not one of them.`
    );
  }

  // Name the failing POSITIONS, same courtesy as consigneesNotFoundError: a
  // requestor with four stops should not have to guess which one broke.
  const bad = params.stopConsignees
    .map((c, i) => (isUwcPlantName(c.company_name) ? null : i + 1))
    .filter((n): n is number => n !== null);
  if (bad.length > 0) {
    const label = bad.length === 1 ? `Stop ${bad[0]} is` : `Stops ${bad.join(", ")} are`;
    throw new ApiError(
      400,
      "DELIVERY_POINT_NOT_A_PLANT",
      `An Inter-Plant booking can only deliver to UWC Plant 1–9. ${label} not a UWC plant.`
    );
  }
}
