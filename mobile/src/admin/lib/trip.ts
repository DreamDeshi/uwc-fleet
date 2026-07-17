import type { Trip } from "../types";
import { palletFactor } from "../../lib/pallets";

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

// Coarse grouping for the trip board.
export function tripGroup(status: string): "pending" | "active" | "completed" | "cancelled" {
  if (status === "pending") return "pending";
  if (status === "assigned" || status === "in_progress" || status === "approved") return "active";
  if (status === "completed") return "completed";
  return "cancelled"; // cancelled | rejected
}
