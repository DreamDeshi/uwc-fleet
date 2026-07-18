/**
 * Daily truck-document expiry reminders.
 *
 * The admin already has an in-app "Document Alerts" panel for expiring
 * insurance / permit / road-tax, but nothing PUSHES — so a lapse only surfaces
 * if someone opens the screen. This job pushes active admins once a day when any
 * non-retired truck has a document due within DOC_EXPIRY_REMIND_DAYS (or already
 * expired), so renewals aren't missed.
 *
 * No "already notified" flag (that would need a schema column): the reminder
 * simply RE-SENDS each day while a document stays within the window, and stops
 * on its own the day the date is renewed past the horizon. A daily nudge until
 * fixed is the intended behaviour. Notification only — no money/dispatch path.
 */
import { prisma } from "../lib/prisma";
import { sendPushNotifications } from "../lib/pushNotifications";

const DAY_MS = 24 * 60 * 60 * 1000;
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const REMIND_HOUR_MYT = 9; // 09:00 MYT daily

function remindWithinDays(): number {
  const n = Number(process.env.DOC_EXPIRY_REMIND_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Where-clause for non-retired trucks with any document at/under the horizon
 * (expiring within `withinDays`, or already expired). Pure/exported so the exact
 * scope is unit-testable and can't silently drift.
 */
export function expiringDocsWhere(now: Date, withinDays: number) {
  const horizon = new Date(now.getTime() + withinDays * DAY_MS);
  return {
    retired_at: null,
    OR: [
      { insurance_expiry: { lte: horizon } },
      { permit_expiry: { lte: horizon } },
      { road_tax_expiry: { lte: horizon } },
    ],
  };
}

/** Push active admins about trucks whose documents expire within the window. Returns the count. */
export async function remindExpiringDocs(now: Date = new Date(), withinDays: number = remindWithinDays()): Promise<number> {
  const trucks = await prisma.truck.findMany({
    where: expiringDocsWhere(now, withinDays),
    select: { plate: true },
    orderBy: { plate: "asc" },
  });
  if (trucks.length === 0) return 0;

  const admins = await prisma.user.findMany({
    where: { role: "admin", status: "active", expo_push_token: { not: null } },
    select: { expo_push_token: true },
  });
  if (admins.length > 0) {
    const plates = trucks.slice(0, 3).map((t) => t.plate).join(", ");
    const more = trucks.length > 3 ? ` +${trucks.length - 3} more` : "";
    await sendPushNotifications(
      admins.map((a) => a.expo_push_token),
      {
        title: "Truck documents expiring",
        body: `${trucks.length} truck(s) have insurance/permit/road-tax due within ${withinDays} days: ${plates}${more}`,
        data: { type: "doc_expiry" },
      }
    );
  }
  console.log(`[doc-expiry-reminders] ${trucks.length} truck(s) with a document within ${withinDays}d`);
  return trucks.length;
}

/** Milliseconds from `now` until the next REMIND_HOUR_MYT. Pure/exported for tests. */
export function msUntilNextReminder(now: Date): number {
  const mytNow = now.getTime() + MYT_OFFSET_MS;
  const dayStartMyt = Math.floor(mytNow / DAY_MS) * DAY_MS;
  let next = dayStartMyt + REMIND_HOUR_MYT * 60 * 60 * 1000;
  if (next <= mytNow) next += DAY_MS;
  return next - mytNow;
}

/**
 * Schedule the daily reminder at 09:00 MYT and every 24h after. Deliberately NO
 * boot run — a deploy/restart at any hour must not fire an off-schedule push (and
 * re-fire on every restart); the fixed daily slot keeps it to one nudge a day.
 */
export function startDocExpiryReminders(): void {
  const run = () => {
    remindExpiringDocs().catch((err) => console.error("Doc-expiry reminders failed:", err));
  };
  const delay = msUntilNextReminder(new Date());
  setTimeout(() => {
    run();
    setInterval(run, DAY_MS);
  }, delay);
}
