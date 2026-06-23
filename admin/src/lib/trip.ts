import type { Trip } from "@/types";

export const ORIGIN_LABEL = "UWC Batu Kawan";

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

export function totalPallets(trip: Trip): number {
  return trip.cargo_details.reduce((sum, c) => sum + c.quantity, 0);
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
