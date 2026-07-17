import type { Trip, TripStatus } from "../types";
import { palletFactor } from "../../lib/pallets";
import { assertNever } from "../../lib/tripStatus";

export const ORIGIN_LABEL = "UWC Batu Kawan";

// 4×4-pallet-equivalent conversion (spec AUTO DISPATCH LOGIC — all capacity is
// measured in 4×4 slots) comes from the shared mirror in ../../lib/pallets,
// which tracks api/src/lib/pallets.ts.
//
// This module used to keep its OWN copy of the factor map — a third one, in the
// same package as the mirror it duplicated. Item 2 (adding five footprints)
// would have had to update all three in lockstep, and the failure mode of
// missing this one is silent: an unknown type converts to 0, so admin capacity
// figures would quietly under-count the new sizes while the booking form and
// the server agreed. Importing removes the drift by construction.
// Cartons/custom, and any unrecognised legacy type, still convert to 0 rather
// than a guessed slot.

export function firstStop(trip: Trip) {
  return [...trip.stops].sort((a, b) => a.sequence - b.sequence)[0];
}

export function tripDestination(trip: Trip): string {
  const stops = [...trip.stops].sort((a, b) => a.sequence - b.sequence);
  const last = stops[stops.length - 1];
  if (!last) return "—";
  const name = last.consignee.area ?? last.consignee.company_name ?? last.consignee.zone_code;
  return stops.length > 1 ? `${name} +${stops.length - 1}` : name;
}

export function tripConsigneeName(trip: Trip): string {
  return firstStop(trip)?.consignee.company_name ?? "—";
}

// NOTE this deliberately does NOT honour a carton/custom line's
// `estimated_pallets` (unlike the server's palletEquivalents) — it is a display
// figure for the admin cargo summary, counting only what has a real footprint.
// 4 dp to match the shared rounding: the finest factor is 1/16 = 0.0625, which
// 3 dp would corrupt to 0.063.
export function totalPallets(trip: Trip): number {
  const total = trip.cargo_details.reduce((sum, c) => sum + palletFactor(c.pallet_type) * c.quantity, 0);
  return Math.round(total * 10000) / 10000;
}

export function cargoSummary(trip: Trip): string {
  const pallets = totalPallets(trip);
  const types = trip.cargo_details.length;
  return `${pallets} pallet${pallets === 1 ? "" : "s"}${types > 1 ? ` · ${types} types` : ""}`;
}

// Delivery progress 0–100 from delivered stops.
export function tripProgress(trip: Trip): number {
  if (trip.status === "completed") return 100;
  if (trip.stops.length === 0) return 0;
  const delivered = trip.stops.filter((s) => s.status === "delivered").length;
  return Math.round((delivered / trip.stops.length) * 100);
}

// Coarse grouping for the trip board's four columns.
//
// The parameter is TripStatus, NOT `string`: it was `string`, which meant no
// exhaustiveness check was even possible and the trailing `return "cancelled"`
// silently absorbed anything it did not recognise. When item 9 added
// `pending_approval`, that fallback filed successfully DELIVERED trips into the
// CANCELLED column of the dispatch board — the screen an admin works from all
// day. Live in prod since the 17 Jul deploy.
export function tripGroup(status: TripStatus): "pending" | "active" | "completed" | "cancelled" {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
    case "assigned":
    case "in_progress":
      return "active";
    // The goods arrived. `pending_approval` is delivered work whose incentive is
    // waiting on an admin — it belongs with completed trips, not with failures.
    // Approving it is done from the dedicated POD Approvals screen, not here.
    case "pending_approval":
    case "completed":
      return "completed";
    case "cancelled":
    case "rejected":
      return "cancelled";
    default:
      // NOT a catch-all — `cancelled`/`rejected` are spelled out above precisely
      // so this narrows to `never`. A 9th TripStatus now fails the build instead
      // of being quietly filed as cancelled, which is the exact bug this
      // function shipped.
      return assertNever(status, "TripStatus");
  }
}
