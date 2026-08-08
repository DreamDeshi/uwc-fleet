import type { Trip } from "../types";
import { totalPallets } from "./trip";

/**
 * The figures behind the requestor Insights hero, week chart and stat tiles
 * (design frame 11), derived on the client from the trips the app already has.
 *
 * WHY NOT THE ANALYTICS ENDPOINT: `/analytics/me` aggregates by month and has
 * no period parameter, so it can answer neither "last 90 days" nor "this week".
 * The trips list is already loaded and polled on every requestor screen, and it
 * carries stops and cargo, so every number the design asks for falls out of it
 * with no API change. The pre-aggregated sections below the fold keep using the
 * endpoint.
 *
 * BUCKETED ON `pickup_datetime`, not `created_at`: these are counts of when the
 * fleet ran, which is what "18 trips in August" means to the person reading it.
 * A booking placed in July for an August pickup belongs to August.
 *
 * CANCELLED AND REJECTED BOTH COUNT AS "didn't happen" for the cancelled rate —
 * a rejected booking is one the requestor also did not get a truck for, and
 * splitting them would put a number on the tile that no requestor could act on.
 */

export type InsightsPeriod = "month" | "quarter";

export interface PeriodBounds {
  start: Date;
  end: Date;
  /** The equally long window immediately before `start`, for the delta. */
  prevStart: Date;
  prevEnd: Date;
}

const DAY_MS = 86_400_000;
const QUARTER_DAYS = 90;

export function periodBounds(period: InsightsPeriod, now: Date): PeriodBounds {
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return {
      start,
      end,
      prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      prevEnd: start,
    };
  }
  const end = new Date(now);
  const start = new Date(+end - QUARTER_DAYS * DAY_MS);
  return { start, end, prevStart: new Date(+start - QUARTER_DAYS * DAY_MS), prevEnd: start };
}

function within(trip: Trip, start: Date, end: Date): boolean {
  const t = +new Date(trip.pickup_datetime);
  return Number.isFinite(t) && t >= +start && t < +end;
}

export interface PeriodStats {
  total: number;
  completed: number;
  /** completed + delivered-awaiting-approval + still-running. */
  cancelled: number;
  /** Percent of the period's bookings that never ran, 1 dp. Null when empty. */
  cancelledPct: number | null;
  /** Mean 4×4-equivalent pallets per booking, 1 dp. Null when empty. */
  avgPallets: number | null;
  /** Percent change against the preceding window. Null when there is no
   *  baseline — "▲ ∞%" against a zero prior month is not a fact. */
  deltaPct: number | null;
}

export function periodStats(trips: Trip[], period: InsightsPeriod, now: Date): PeriodStats {
  const { start, end, prevStart, prevEnd } = periodBounds(period, now);
  const current = trips.filter((tr) => within(tr, start, end));
  const previous = trips.filter((tr) => within(tr, prevStart, prevEnd));

  const completed = current.filter(
    (tr) => tr.status === "completed" || tr.status === "pending_approval"
  ).length;
  const cancelled = current.filter(
    (tr) => tr.status === "cancelled" || tr.status === "rejected"
  ).length;

  const pallets = current.reduce((sum, tr) => sum + totalPallets(tr), 0);
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    total: current.length,
    completed,
    cancelled,
    cancelledPct: current.length === 0 ? null : round1((cancelled / current.length) * 100),
    avgPallets: current.length === 0 ? null : round1(pallets / current.length),
    deltaPct:
      previous.length === 0
        ? null
        : Math.round(((current.length - previous.length) / previous.length) * 100),
  };
}

export interface WeekBar {
  /** 0 = Monday … 6 = Sunday, matching the chart's Mon-first axis. */
  index: number;
  count: number;
  isToday: boolean;
}

/** Monday of the week `now` falls in, at 00:00 local. */
export function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay() is Sunday-first
  return d;
}

/** Seven Mon→Sun buckets for the current week's pickups. */
export function weekSeries(trips: Trip[], now: Date): WeekBar[] {
  const monday = startOfWeek(now);
  const todayIndex = (now.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => {
    const dayStart = new Date(monday);
    dayStart.setDate(dayStart.getDate() + index);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return {
      index,
      count: trips.filter((tr) => within(tr, dayStart, dayEnd)).length,
      isToday: index === todayIndex,
    };
  });
}
