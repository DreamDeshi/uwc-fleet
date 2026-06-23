import { Trip } from "../types";

// Most trips originate at the UWC plant; the schema doesn't model the origin
// explicitly, so we label it consistently.
export const ORIGIN_LABEL = "UWC Batu Kawan";

export function firstStop(trip: Trip) {
  return trip.stops && trip.stops.length > 0 ? trip.stops[0] : undefined;
}

export function tripDestination(trip: Trip): string {
  const s = firstStop(trip);
  const c = s?.consignee;
  return c?.area || c?.company_name || c?.zone?.name || c?.zone_code || "—";
}

export function tripDestZone(trip: Trip): string | undefined {
  return firstStop(trip)?.consignee?.zone_code;
}

export function tripConsigneeName(trip: Trip): string {
  return firstStop(trip)?.consignee?.company_name || "—";
}

// "Pallet 4×4 × 3  (+1 more)" style summary from the cargo lines.
export function cargoSummary(trip: Trip): string {
  const lines = trip.cargo_details ?? [];
  if (lines.length === 0) return "—";
  const first = lines[0];
  const label =
    first.pallet_type === "carton"
      ? `Carton × ${first.cartons ?? first.quantity}`
      : first.pallet_type === "custom"
        ? first.custom_size || "Custom"
        : `Pallet ${first.pallet_type} × ${first.quantity}`;
  return lines.length > 1 ? `${label}  (+${lines.length - 1} more)` : label;
}

export function totalPallets(trip: Trip): number {
  return (trip.cargo_details ?? [])
    .filter((c) => c.pallet_type !== "carton" && c.pallet_type !== "custom")
    .reduce((sum, c) => sum + (c.quantity || 0), 0);
}
