import { inMytMonth } from "../lib/myt";

/**
 * The clerk's month-end payroll sheet (audit part B): one row per driver with
 * the month's trip count and RM total, plus the per-trip lines a pay dispute
 * is traced through. Pure — the route feeds it drivers + completed trips; it
 * only filters (shared inMytMonth predicate — the same [start, end) bounds
 * every other money figure uses), sums and rounds. It never computes pay:
 * totals are sums of the stored per-trip incentive_earned.
 *
 * Bucketing keys on the DELIVERY instant (delivered_at, pickup fallback for
 * the legacy null case) — the same day the incentive ledger paid the trip on,
 * so this sheet and pay can never disagree about a month-crossing trip. Every
 * other "this month" figure (dashboard, drivers report, performance, driver
 * app) keys on the same instant; keep them moving together.
 */

export interface PayrollTripInput {
  id: string;
  ticket_number: string;
  pickup_datetime: Date;
  /** First delivery confirm — the pay-deciding instant the month bucket keys on. */
  delivered_at: Date | null;
  incentive_earned: unknown; // Prisma Decimal | string | number | null
}

export interface PayrollDriverInput {
  id: string;
  name: string;
  employee_number: string | null;
  trips: PayrollTripInput[];
}

export interface PayrollTripRow {
  id: string;
  ticket_number: string;
  pickup_datetime: Date;
  delivered_at: Date | null;
  incentive_earned: number; // per-trip stored marginal, as a plain number
}

export interface PayrollDriverRow {
  driver_id: string;
  name: string;
  employee_number: string | null;
  trip_count: number;
  /** Month total in RM, rounded to cents (sum of stored per-trip marginals). */
  total: number;
  trips: PayrollTripRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Deterministic binary string compare (NOT localeCompare — that varies with the
// server's locale/ICU build, and a month-end sheet must order identically
// everywhere it's generated).
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function buildPayrollRows(
  drivers: PayrollDriverInput[],
  bounds: { start: Date; end: Date }
): PayrollDriverRow[] {
  return drivers
    .map((d) => {
      // Pay-day attribution: the month a trip DELIVERED in (pickup only as the
      // legacy fallback) — same rule as services/tripCompletion payAttributionInstant.
      const payInstant = (t: PayrollTripInput) => new Date(t.delivered_at ?? t.pickup_datetime);
      const monthTrips = d.trips
        .filter((t) => inMytMonth(payInstant(t), bounds))
        .sort((a, b) => payInstant(a).getTime() - payInstant(b).getTime())
        .map((t) => ({
          id: t.id,
          ticket_number: t.ticket_number,
          pickup_datetime: t.pickup_datetime,
          delivered_at: t.delivered_at,
          incentive_earned: round2(Number(t.incentive_earned ?? 0)),
        }));
      return {
        driver_id: d.id,
        name: d.name,
        employee_number: d.employee_number,
        trip_count: monthTrips.length,
        // Rounded once at the end: summing stored cents-clean marginals can
        // still pick up float dust, and this figure is what payroll pays.
        total: round2(monthTrips.reduce((sum, t) => sum + t.incentive_earned, 0)),
        trips: monthTrips,
      };
    })
    .sort(
      // Total desc, then deterministic tiebreaks: name, employee number, id.
      // Ties used to fall back to caller order (stable sort, no secondary key),
      // so the same month's sheet could order tied drivers differently across
      // runs depending on how the route happened to feed them. Now identical
      // inputs produce an identical sheet regardless of input order.
      (a, b) =>
        b.total - a.total ||
        cmp(a.name, b.name) ||
        cmp(a.employee_number ?? "", b.employee_number ?? "") ||
        cmp(a.driver_id, b.driver_id)
    );
}
