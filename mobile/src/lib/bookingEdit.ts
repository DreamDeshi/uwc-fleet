import type { CargoDetail } from "../types";

// The booking form's quick pickers offer whole hours across the fleet operating
// window within the next 7 days (see BookingFormScreen dayOptions/timeOptions).
// When a booking is opened for EDITING, its stored pickup_datetime has to be
// reversed into those buckets so an untouched pickup round-trips unchanged (the
// server only enforces the not-in-the-past rule when the pickup actually
// CHANGED).
//
// The window is 07:00 → 02:00 and WRAPS midnight (item 12, Mr. Teh 17 Jul 2026:
// "can pickup time allow set until 2AM instead of 6pm"), so the offered hours
// are a union of two halves, not a min..max range. Mirrors the server's
// DEFAULT_WINDOW_START/END in api/src/services/operatingWindow.ts.
//
// The old bounds were 08..18, which ALSO never offered 07:00 even though the
// server has always opened the window then — an hour of the fleet's day was
// unbookable from the form. Starting the list at 07:00 closes that gap.
export const PICKUP_WINDOW_START_HOUR = 7;
export const PICKUP_WINDOW_END_HOUR = 2;
export const PICKUP_MAX_DAY_OFFSET = 6;

/**
 * The bookable hours in OPERATING-DAY order: 07:00…23:00 then 00:00…02:00, so
 * the picker reads the way the shift runs rather than jumping back to midnight.
 * An hour is a valid pickup iff it appears here.
 */
export const PICKUP_HOURS: readonly number[] = [
  ...Array.from({ length: 24 - PICKUP_WINDOW_START_HOUR }, (_, i) => PICKUP_WINDOW_START_HOUR + i),
  ...Array.from({ length: PICKUP_WINDOW_END_HOUR + 1 }, (_, i) => i),
];

/** Is this whole hour inside the (wrapping) pickup window? */
export function isPickupHour(hour: number): boolean {
  return PICKUP_HOURS.includes(hour);
}

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
  if (!isPickupHour(hour)) return null;
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
