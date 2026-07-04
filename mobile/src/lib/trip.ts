import i18n from "i18next";
import { Trip } from "../types";
import { palletFactor } from "./pallets";

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

// "Pallet 4×4 × 3  (+1 more)" style summary from the cargo lines. Localised
// (these lines sit on the driver's pay-adjacent cards) via i18n.t directly —
// same lib-level pattern as format.ts. "{{qty}}" not "{{count}}" on purpose:
// count triggers i18next plural-key lookup these keys don't define.
export function cargoSummary(trip: Trip): string {
  const lines = trip.cargo_details ?? [];
  if (lines.length === 0) return "—";
  const first = lines[0];
  const label =
    first.pallet_type === "carton"
      ? i18n.t("cargo.carton", { qty: first.cartons ?? first.quantity })
      : first.pallet_type === "custom"
        ? first.custom_size || i18n.t("cargo.custom")
        : i18n.t("cargo.pallet", { size: first.pallet_type, qty: first.quantity });
  return lines.length > 1 ? `${label}  ${i18n.t("cargo.more", { qty: lines.length - 1 })}` : label;
}

// 4×4-pallet-equivalent conversion lives in lib/pallets.ts (single mirror of
// api/src/lib/pallets.ts, unit-tested) — imported above.

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

// Off-peak = Saturday/Sunday (MYT), a Malaysian public holiday, or a weekday
// at/after 18:00 MYT. Mirrors the server's incentiveEngine.isOffPeak.
// `publicHolidays` comes from GET /holidays (the admin-managed calendar) via
// useHolidays() — there is deliberately NO baked-in holiday list on the client
// anymore (the old hardcoded copy carried wrong dates and drifted from the
// server). An empty set (calendar still loading) just means "no holidays".
function isOffPeak(date: Date, publicHolidays: ReadonlySet<string>): boolean {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  const day = myt.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return true;
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = `${myt.getUTCFullYear()}-${pad(myt.getUTCMonth() + 1)}-${pad(myt.getUTCDate())}`;
  if (publicHolidays.has(key)) return true;
  return myt.getUTCHours() >= 18;
}

// Estimated incentive shown before a trip is completed: each stop scored with
// the per-zone-per-day rule (first stop into a zone = full points, repeats = 1),
// minus the truck's daily deduction on the first stop (floored at 0), × the
// truck's entitled-claim rate (off-peak on weekends / holidays / after 6pm MYT).
// The final amount may still differ (a later trip of the day earns fewer
// points), so the UI labels this "Estimated". Returns null when it can't tell.
export function estimateIncentive(
  trip: Trip,
  publicHolidays: ReadonlySet<string>
): number | null {
  const truck = trip.truck;
  if (!truck) return null;
  const rateRaw = isOffPeak(new Date(trip.pickup_datetime), publicHolidays)
    ? truck.entitled_claim_offpeak
    : truck.entitled_claim_weekday;
  const rate = Number(rateRaw);
  if (rateRaw == null || !Number.isFinite(rate)) return null;

  const stops = [...(trip.stops ?? [])].sort((a, b) => a.sequence - b.sequence);

  // Mirrors the server's per-zone-per-day rule, scored across THIS trip's stops:
  // the first stop into a zone earns the zone's full points, a repeat zone earns
  // 1. The daily deduction lands once, on the first stop.
  //
  // Pre-completion estimate caveat: this pure client function only sees this
  // trip's stops, so it assumes this is the driver's first trip of the day (the
  // deduction applies here) and cannot know zones already hit by the driver's
  // OTHER trips today. The server also keys the day AND the rate tier on the
  // DELIVERY confirm time (client rule 3 Jul 2026) which hasn't happened yet,
  // so this estimate uses the pickup time as the best available stand-in.
  // The server's finalized incentive_earned is authoritative.
  const deduction = truck.daily_deduction_points ?? 0;
  const seen = new Set<string>();
  let total = 0;
  let counted = false;
  let firstStop = true;
  for (const s of stops) {
    const zone = s.consignee?.zone_code;
    const full = zone ? ZONE_POINTS[zone] : undefined;
    if (!zone || full == null) continue;
    let points = seen.has(zone) ? 1 : full;
    seen.add(zone);
    if (firstStop) {
      points = Math.max(points - deduction, 0); // floored at 0
      firstStop = false;
    }
    total += points * rate;
    counted = true;
  }
  if (!counted) return null;
  return Math.round(total * 100) / 100;
}

export function totalPallets(trip: Trip): number {
  const total = (trip.cargo_details ?? []).reduce(
    (sum, c) => sum + palletFactor(c.pallet_type) * (c.quantity || 0),
    0
  );
  return Math.round(total * 1000) / 1000;
}
