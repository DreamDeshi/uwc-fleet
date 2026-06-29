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

// ── Estimated incentive (pre-completion display only) ──────────────────────
// Destination points per zone (spec INTERNAL LORRY RATE / DestinationRate seed).
// Mirrored on the client purely to ESTIMATE a trip's incentive before it's
// finalised — the real figure is computed server-side by the incentive engine
// and stored on the trip. If admin edits a zone's points this can drift, which
// is acceptable for an estimate.
const ZONE_POINTS: Record<string, number> = {
  P1: 3, P2: 1, P3: 3, K1: 3, K2: 4, A1: 5, A2: 6, JH: 8, SL: 8,
};

// Malaysia time is a fixed UTC+8 with no daylight saving, so we evaluate the
// pickup's wall-clock by shifting the instant +8h and reading the UTC parts.
// This matches the server's incentiveEngine, which bins everything in MYT —
// reading the device's local clock would mis-rate trips on a phone (or web
// build) whose timezone isn't Malaysia.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// Malaysian public holidays 2026 (brief Section 18), deduped to "YYYY-MM-DD".
// On these dates the off-peak rate table applies all day. Kept in sync with
// api/src/services/incentiveEngine.ts MY_PUBLIC_HOLIDAYS_2026.
const MY_PUBLIC_HOLIDAYS_2026: Set<string> = new Set([
  "2026-01-01", // New Year's Day
  "2026-01-29", // Chinese New Year
  "2026-01-30", // Chinese New Year (2nd day)
  "2026-02-01", // Federal Territory Day
  "2026-03-28", // Hari Raya Aidilfitri
  "2026-03-29", // Hari Raya Aidilfitri (2nd day)
  "2026-04-14", // Thaipusam (Penang)
  "2026-05-01", // Labour Day
  "2026-05-20", // Wesak Day
  "2026-06-05", // Hari Raya Aidiladha
  "2026-06-08", // Yang di-Pertuan Agong Birthday
  "2026-07-07", // Awal Muharram
  "2026-08-31", // National Day
  "2026-09-16", // Malaysia Day / Prophet Muhammad Birthday (same date in brief)
  "2026-10-20", // Deepavali
  "2026-12-25", // Christmas
]);

// Off-peak = Saturday/Sunday (MYT), a Malaysian public holiday, or a weekday
// at/after 18:00 MYT. Mirrors the server's incentiveEngine.isOffPeak.
function isOffPeak(date: Date): boolean {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const day = myt.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return true;
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = `${myt.getUTCFullYear()}-${pad(myt.getUTCMonth() + 1)}-${pad(myt.getUTCDate())}`;
  if (MY_PUBLIC_HOLIDAYS_2026.has(key)) return true;
  return myt.getUTCHours() >= 18;
}

// Estimated incentive shown before a trip is completed: (destination points −
// the truck's daily deduction, floored at 0) × the truck's entitled-claim rate
// (off-peak rate on weekends / holidays / after 6pm MYT), matching the engine's
// first-trip-of-day case. The final amount may still differ (a later trip of the
// day earns fewer points, or completion tips into off-peak), so the UI labels
// this "Estimated". Uses the last stop's zone, the same one the engine finalises
// on. Returns null when it can't tell.
export function estimateIncentive(trip: Trip): number | null {
  const truck = trip.truck;
  if (!truck) return null;
  const stops = [...(trip.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
  const destZone = stops[stops.length - 1]?.consignee?.zone_code;
  const points = destZone ? ZONE_POINTS[destZone] : undefined;
  if (points == null) return null;
  const rateRaw = isOffPeak(new Date(trip.pickup_datetime))
    ? truck.entitled_claim_offpeak
    : truck.entitled_claim_weekday;
  const rate = Number(rateRaw);
  if (rateRaw == null || !Number.isFinite(rate)) return null;
  // Apply the once-per-day points deduction the engine takes before multiplying
  // by the rate (floored at 0 so a small first trip never goes negative).
  const deduction = truck.daily_deduction_points ?? 0;
  const netPoints = Math.max(points - deduction, 0);
  return netPoints * rate;
}

export function totalPallets(trip: Trip): number {
  const total = (trip.cargo_details ?? []).reduce(
    (sum, c) => sum + palletFactor(c.pallet_type) * (c.quantity || 0),
    0
  );
  return Math.round(total * 1000) / 1000;
}
