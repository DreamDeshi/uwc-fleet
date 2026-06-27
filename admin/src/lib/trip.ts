import type { Trip } from "@/types";

export const ORIGIN_LABEL = "UWC Batu Kawan";

// 4×4-pallet-equivalent conversion (spec AUTO DISPATCH LOGIC — all capacity is
// measured in 4×4 slots). Mirrors api/src/lib/pallets.ts; "×" is U+00D7 to match
// the pallet sizes the booking form stores. Cartons/custom occupy no slot.
const PALLET_FACTORS: Record<string, number> = {
  "2×2": 0.25,
  "3×4": 0.75,
  "4×4": 1,
  "4×8": 2,
  "5×10": 3.125,
};

function palletFactor(palletType: string): number {
  if (palletType in PALLET_FACTORS) return PALLET_FACTORS[palletType];
  if (palletType === "carton" || palletType === "custom") return 0;
  return 1;
}

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
  const total = trip.cargo_details.reduce((sum, c) => sum + palletFactor(c.pallet_type) * c.quantity, 0);
  return Math.round(total * 1000) / 1000;
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
