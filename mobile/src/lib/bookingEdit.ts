import type { CargoDetail } from "../types";

// The booking form's pickers offer 5-minute slots across the fleet operating
// window, on any date within a year (calendar + dial — see lib/pickupCalendar).
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

/**
 * B7 — THE BOOKING CUT-OFFS, MIRRORED FROM `api/src/lib/bookingCutoff.ts`.
 *
 * Mr. Teh (11 Aug 2026): "cut of time for morning delivery 830am, afternoon
 * 130pm…if booking after cut off time, they have to choose next working day,
 * for return cargo from supplier / customer, they can choose pickup anytime
 * before 12am".
 *
 * The SERVER is the authority and rejects a late booking outright. These exist
 * so the calendar never OFFERS a slot the server will refuse — a requestor
 * picking a time the app showed them and getting an error is not an edge case,
 * it is the main booking path on the build the client is looking at.
 *
 * ⚠ A MIRROR, and mirrors drift. `lib/pickupCalendar.test.ts` names the server
 * file and these three values together, so a change on one side has to walk
 * past a test that points at the other. Same discipline as the window above.
 *
 * ⚠ DEVICE CLOCK vs MYT. Everything in the picker is device-local, as the
 * window already is; the server decides in MYT. The two agree in Malaysia,
 * where every user of this app is, and the server remains the authority for
 * anyone who is not — they would see a slot refused rather than a slot silently
 * accepted, which is the safe direction of that disagreement.
 */
export const MORNING_CUTOFF_MIN = 8 * 60 + 30; // 08:30 — his
export const AFTERNOON_CUTOFF_MIN = 13 * 60 + 30; // 13:30 — his
/** Noon. OURS, not his — see the server constant, which is env-tunable. */
export const SESSION_SPLIT_MIN = 12 * 60;

/**
 * How far ahead the calendar lets a requestor book: a full year, per the
 * requestor design ("Bookable through … · full year ahead").
 *
 * This is a CLIENT-SIDE affordance only. `createTripSchema` has never had an
 * upper bound — it refines pickup_datetime on the past edge alone (with a 15
 * minute grace) — so widening the picker from 7 days to a year submits nothing
 * the API did not already accept. The old 6 was the dropdown's length, not a
 * rule.
 */
export const PICKUP_MAX_DAY_OFFSET = 365;

/**
 * The minute dial's granularity. The server stores whatever instant it is sent,
 * so this is purely how fine the picker lets you aim; every previously created
 * booking is on :00, which is still on the grid.
 */
export const PICKUP_MINUTE_STEP = 5;

/** The dial's minute ring: 00, 05, … 55. */
export const PICKUP_MINUTES: readonly number[] = Array.from(
  { length: 60 / PICKUP_MINUTE_STEP },
  (_, i) => i * PICKUP_MINUTE_STEP
);

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

/** A pickup as the form holds it: a calendar day offset plus a wall-clock time. */
export interface PickupSlot {
  dayOffset: number;
  hour: number;
  minute: number;
}

/**
 * Map a stored pickup to the form's {dayOffset, hour, minute} buckets, or null
 * when it isn't representable (already past, beyond the year window, outside
 * picker hours, or off the 5-minute grid) — the caller then falls back to the
 * next bookable slot and the user sees the new pickup on the Confirm step. Uses
 * device-local time throughout, matching how the form builds pickupDate.
 */
export function pickupToSlot(
  pickupIso: string,
  now: Date
): PickupSlot | null {
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
  const minute = pickup.getMinutes();
  // Off-grid minutes (a booking placed by an admin, or by a future finer
  // picker) are NOT representable: the dial could not show them, so seeding it
  // with 09:07 would silently round the requestor's pickup on save.
  if (minute % PICKUP_MINUTE_STEP !== 0) return null;
  return { dayOffset, hour, minute };
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
