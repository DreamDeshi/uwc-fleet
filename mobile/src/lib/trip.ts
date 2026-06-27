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

export function totalPallets(trip: Trip): number {
  const total = (trip.cargo_details ?? []).reduce(
    (sum, c) => sum + palletFactor(c.pallet_type) * (c.quantity || 0),
    0
  );
  return Math.round(total * 1000) / 1000;
}
