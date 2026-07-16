import type { CargoDetail } from "../types";

// The booking form's quick pickers only offer whole hours 08:00–18:00 within
// the next 7 days (see BookingFormScreen dayOptions/timeOptions). When a
// booking is opened for EDITING, its stored pickup_datetime has to be reversed
// into those buckets so an untouched pickup round-trips unchanged (the server
// only enforces the not-in-the-past rule when the pickup actually CHANGED).
export const PICKUP_MIN_HOUR = 8;
export const PICKUP_MAX_HOUR = 18;
export const PICKUP_MAX_DAY_OFFSET = 6;

/**
 * Map a stored pickup to the form's {dayOffset, hour} buckets, or null when it
 * isn't representable (already past, beyond the 7-day window, outside picker
 * hours, or not on a whole hour) — the caller then falls back to the next
 * bookable slot and the user sees the new pickup on the Confirm step. Uses
 * device-local time throughout, matching how the form builds pickupDate.
 */
export function pickupToSlot(
  pickupIso: string,
  now: Date
): { dayOffset: number; hour: number } | null {
  const pickup = new Date(pickupIso);
  if (Number.isNaN(pickup.getTime())) return null;

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const pickupDayStart = new Date(pickup);
  pickupDayStart.setHours(0, 0, 0, 0);
  // Round, not floor: a DST jump on a device outside Malaysia makes the
  // midnight-to-midnight span ±1h off a whole day.
  const dayOffset = Math.round(
    (pickupDayStart.getTime() - todayStart.getTime()) / 86_400_000
  );

  if (dayOffset < 0 || dayOffset > PICKUP_MAX_DAY_OFFSET) return null;
  const hour = pickup.getHours();
  if (hour < PICKUP_MIN_HOUR || hour > PICKUP_MAX_HOUR) return null;
  if (pickup.getMinutes() !== 0) return null;
  return { dayOffset, hour };
}

/**
 * The booking's remarks, for seeding the edit form. The create form stores the
 * remarks box on the FIRST cargo line (buildCargo), so the first non-empty
 * line remark is the booking's remarks.
 */
export function tripRemarks(cargoDetails: Pick<CargoDetail, "remark">[] | undefined): string {
  for (const line of cargoDetails ?? []) {
    if (line.remark && line.remark.trim().length > 0) return line.remark;
  }
  return "";
}
