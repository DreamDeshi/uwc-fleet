// How long a trip has been sitting, in a unit a person can actually read.
//
// "108h since pickup" is arithmetic homework: nobody divides by 24 in their head
// to discover it means four and a half days, and the number that should trigger
// alarm instead slides past as just another figure. Hours stay while they are
// still countable; past two days it switches to days, and past a fortnight to
// the pickup DATE, which by then is the more useful fact anyway — at that age
// you want to know which day it went out, not how many sleeps ago that was.
//
// Sign carries direction: negative hours are a pickup still in the future.
import { formatDate } from "./format";

export const DAYS_CUTOFF_H = 48;
export const DATE_CUTOFF_H = 24 * 14;

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export function pickupAge(
  hoursSincePickup: number,
  pickupDatetime: string | null | undefined,
  t: Translate
): string {
  const h = Math.round(hoursSincePickup);
  const abs = Math.abs(h);
  const future = h < 0;
  // The date branch needs a timestamp to render. Without one — an API older
  // than the field, or a null pickup — fall through to days rather than
  // printing an empty date, which would read as a missing value.
  if (abs >= DATE_CUTOFF_H && pickupDatetime) {
    return t("admin.dashboard.pickupOnDate", { date: formatDate(pickupDatetime) });
  }
  if (abs >= DAYS_CUTOFF_H) {
    const days = Math.round(abs / 24);
    return t(future ? "admin.dashboard.untilPickupDays" : "admin.dashboard.sincePickupDays", { count: days });
  }
  return t(future ? "admin.dashboard.untilPickup" : "admin.dashboard.sincePickup", { h: abs });
}
