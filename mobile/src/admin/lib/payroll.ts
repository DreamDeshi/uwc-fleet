// Month-selector keys and the payroll CSV — pure helpers so the export can be
// tested to tie EXACTLY to what the page displays.
import { toCsv } from "./csv";
import { formatDateTime, money2dp, mytDateKey } from "./format";
import type { MonthlyRow, PayrollDriverRow } from "../types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Last n MYT month keys, current first (e.g. ["2026-07", "2026-06", …]). */
export function lastNMytMonthKeys(now: Date, n: number): string[] {
  const [y, m] = mytDateKey(now).slice(0, 7).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    // Date.UTC normalises negative month indices across year boundaries.
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function monthKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return key;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/**
 * Whether the payroll rows on screen are still settling for the SELECTED
 * month. The query keeps the PREVIOUS month's rows as placeholder data while
 * a month-switch fetch is in flight (so isLoading stays false) — exporting in
 * that window writes a CSV stamped with the new month key but containing the
 * old month's totals (audit 2026-07-05 #1). The table dims and Export is
 * disabled while this is true.
 */
export function payrollBusy(q: { isFetching: boolean; isPlaceholderData: boolean }): boolean {
  return q.isFetching || q.isPlaceholderData;
}

/**
 * The month-end export: a per-driver payroll section (what the clerk pays
 * from), a per-trip detail section (what a dispute is traced through), and
 * the 6-month aggregate summary. Every money cell goes through money2dp so
 * the exported number equals the displayed formatMoney value exactly.
 */
export function buildPayrollCsv(
  monthKey: string,
  drivers: PayrollDriverRow[],
  months: MonthlyRow[]
): string {
  return toCsv([
    [`UWC Driver Payroll — ${monthKeyLabel(monthKey)}`],
    ["Driver", "Employee No", "Trips", "Total (RM)", "Month"],
    ...drivers.map((d) => [d.name, d.employee_number ?? "", d.trip_count, money2dp(d.total), monthKey]),
    [],
    [`Trip detail — ${monthKeyLabel(monthKey)}`],
    ["Driver", "Ticket", "Delivered (MYT)", "Amount (RM)"],
    ...drivers.flatMap((d) =>
      d.trips.map((t) => [
        d.name,
        t.ticket_number,
        // The pay-deciding instant; pickup as fallback for legacy rows.
        formatDateTime(t.delivered_at ?? t.pickup_datetime),
        money2dp(t.incentive_earned),
      ])
    ),
    [],
    ["Monthly Performance Summary"],
    ["Month", "Trips", "Completed", "Incentive (RM)", "External"],
    ...months.map((m) => [m.label, m.trips, m.completed, money2dp(m.incentive), m.external]),
  ]);
}
