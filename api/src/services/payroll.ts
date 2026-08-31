import { inMytMonth } from "../lib/myt";
import { payableIncentive } from "./tripCompletion";

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
  incentive_earned: unknown; // Prisma Decimal | string | number | null — the engine PROPOSAL
  incentive_final?: unknown; // admin-approved payable amount; null on pre-approval-gate trips
}

/**
 * A correction against a trip whose pay-attribution month may be a PRIOR
 * month entirely — this driver's own earlier IncentiveAdjustment rows,
 * filtered by the route to those whose `effective_month` matches the sheet
 * being built (R6-2: an adjustment lands in the month it was CREATED in,
 * never the trip's original month). See services/incentiveAdjustments.ts.
 */
export interface PayrollAdjustmentInput {
  trip_id: string;
  ticket_number: string;
  delta: unknown; // Prisma Decimal | string | number
  reason: string;
  created_at: Date;
}

export interface PayrollDriverInput {
  id: string;
  name: string;
  employee_number: string | null;
  trips: PayrollTripInput[];
  /** This driver's adjustments EFFECTIVE in the sheet's month — already
   * pre-filtered by the caller. Optional so every existing caller/fixture
   * that predates this feature keeps working unchanged. */
  adjustments?: PayrollAdjustmentInput[];
}

export interface PayrollTripRow {
  id: string;
  ticket_number: string;
  pickup_datetime: Date;
  delivered_at: Date | null;
  incentive_earned: number; // per-trip stored marginal, as a plain number
}

export interface PayrollAdjustmentRow {
  trip_id: string;
  ticket_number: string;
  delta: number;
  reason: string;
  created_at: Date;
}

export interface PayrollDriverRow {
  driver_id: string;
  name: string;
  employee_number: string | null;
  trip_count: number;
  /** Month total in RM, rounded to cents — sum of stored per-trip marginals
   * PLUS any adjustment deltas effective this month. A total that differs
   * from trip_count × per-trip figures without adjustments to explain it
   * would be exactly the "same report, different numbers" defect R6-2/R6-3
   * exist to prevent. */
  total: number;
  trips: PayrollTripRow[];
  /** Rendered as its OWN labeled line, never merged into `trips` — an
   * adjustment has no pickup/delivery instant of its own, and mixing it into
   * the trip list would misrepresent it as a trip that happened this month. */
  adjustments: PayrollAdjustmentRow[];
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
          // The PAID amount: admin-approved final, or the engine proposal for
          // grandfathered pre-gate trips (payableIncentive). The row field keeps
          // its name — it is what payroll pays.
          incentive_earned: round2(payableIncentive(t)),
        }));
      // Caller has already filtered these to the sheet's own effective_month
      // (R6-2) — this function only sums and formats, same discipline as the
      // trip totals above.
      const adjustments = (d.adjustments ?? [])
        .slice()
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((a) => ({
          trip_id: a.trip_id,
          ticket_number: a.ticket_number,
          delta: round2(Number(a.delta)),
          reason: a.reason,
          created_at: a.created_at,
        }));
      return {
        driver_id: d.id,
        name: d.name,
        employee_number: d.employee_number,
        trip_count: monthTrips.length,
        // Rounded once at the end: summing stored cents-clean marginals can
        // still pick up float dust, and this figure is what payroll pays.
        // Includes adjustment deltas, per R6-2 — this month's sheet is the
        // ONLY place a correction is ever visible in the total.
        total: round2(
          monthTrips.reduce((sum, t) => sum + t.incentive_earned, 0) +
            adjustments.reduce((sum, a) => sum + a.delta, 0)
        ),
        trips: monthTrips,
        adjustments,
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
