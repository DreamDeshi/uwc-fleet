import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMonthly, usePayroll, useTrips } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, ErrorState, Loading, SectionTitle } from "@/components/ui";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import { buildPayrollCsv, lastNMytMonthKeys, monthKeyLabel, payrollBusy } from "@/lib/payroll";
import type { MonthlyRow, PayrollDriverRow } from "@/types";

const PIE_COLORS = [colors.blue, colors.yellow, colors.green, colors.orange, "#9333ea", "#0891b2"];

export function ReportsPage() {
  const monthly = useMonthly();
  const trips = useTrips();
  // Month-end payroll: any MYT month selectable (the clerk closes LAST month
  // in the first days of the next one, so "current month only" was useless).
  const monthOptions = useMemo(() => lastNMytMonthKeys(new Date(), 12), []);
  const [month, setMonth] = useState(monthOptions[0]);
  const payroll = usePayroll(month);

  const routeSplit = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trips.data ?? []) {
      map.set(t.route_type.name, (map.get(t.route_type.name) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, value]) => ({ name, value }));
  }, [trips.data]);

  if (monthly.isLoading || payroll.isLoading) return <Loading />;
  if (monthly.isError) return <ErrorState message="Could not load reports." onRetry={() => monthly.refetch()} />;

  const months = monthly.data ?? [];
  const payrollRows = payroll.data?.drivers ?? [];
  // A month switch serves the PREVIOUS month's rows as placeholder while the
  // new month fetches (isLoading stays false) — until it settles, the table
  // dims and Export is disabled, or the clerk could save a CSV stamped with
  // the selected month but holding the old month's totals (audit #1).
  const payrollSettling = payrollBusy(payroll);

  const totalTrips = months.reduce((s, m) => s + m.trips, 0);
  const totalIncentive = months.reduce((s, m) => s + m.incentive, 0);
  const totalExternal = months.reduce((s, m) => s + m.external, 0);
  const avgTrip = (() => {
    const completed = months.reduce((s, m) => s + m.completed, 0);
    return completed ? totalIncentive / completed : 0;
  })();

  function exportCsv() {
    // Belt-and-braces with the disabled button: never write a sheet while the
    // rows on screen may still be another month's placeholder data.
    if (payrollSettling) return;
    // The month-end export (lib/payroll, unit-tested): per-driver payroll
    // rows for the SELECTED month, per-trip detail for dispute tracing, and
    // the 6-month aggregates. Money cells tie exactly to the displayed
    // formatMoney values (2dp, float dust rounded away).
    const csv = buildPayrollCsv(month, payrollRows, months);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uwc-payroll-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {/* Disabled while the payroll month is settling — never export rows
            that don't yet belong to the selected month. */}
        <Button variant="primary" size="sm" onClick={exportCsv} disabled={payrollSettling}>
          {payrollSettling ? "Loading payroll…" : "⬇ Export CSV"}
        </Button>
      </div>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <MiniKpi label="Total Incentive (6 mo.)" value={formatMoney(totalIncentive)} bg={colors.blueTint} fg={colors.blue} />
        <MiniKpi label="Avg / Completed Trip" value={formatMoney(avgTrip)} bg={colors.greenTint} fg={colors.green} />
        <MiniKpi label="Total Trips" value={formatNumber(totalTrips)} bg={colors.yellowTint} fg={colors.amber} />
        <MiniKpi label="External Trips" value={formatNumber(totalExternal)} bg={colors.orangeTint} fg={colors.orange} />
      </div>

      {/* Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <Card>
          <SectionTitle title="Incentive by Month" subtitle="Last 6 months" />
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={months} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: colors.textMuted }} tickFormatter={(l: string) => l.split(" ")[0]} />
              <YAxis tick={{ fontSize: 11, fill: colors.textMuted }} tickFormatter={(v: number) => `RM${v}`} />
              <RTooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="incentive" fill={colors.blue} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <SectionTitle title="Route Type Split" subtitle={`${routeSplit.reduce((s, r) => s + r.value, 0)} trips`} />
          {routeSplit.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: colors.textMuted, fontSize: 13 }}>No trips yet.</div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <ResponsiveContainer width="55%" height={180}>
                <PieChart>
                  <Pie data={routeSplit} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                    {routeSplit.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <RTooltip />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                {routeSplit.map((r, i) => (
                  <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span style={{ flex: 1, color: colors.textMuted }}>{r.name}</span>
                    <span style={{ fontWeight: 700 }}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Payroll table — the clerk's month-end sheet. Click a row to trace
          the total down to individual trips (dispute path). */}
      <Card pad={0}>
        <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SectionTitle title="Driver Payroll" subtitle="Month totals from stored per-trip pay — click a driver for trip detail" />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {payrollSettling && (
              <span style={{ fontSize: 12, color: colors.textMuted }}>Loading {monthKeyLabel(month)}…</span>
            )}
            <select value={month} onChange={(e) => setMonth(e.target.value)} style={monthSelectStyle}>
              {monthOptions.map((k) => (
                <option key={k} value={k}>
                  {monthKeyLabel(k)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* Dimmed while settling: the rows below may still be the previous
            month's placeholder data. */}
        <table style={{ width: "100%", borderCollapse: "collapse", opacity: payrollSettling ? 0.45 : 1, transition: "opacity 120ms" }}>
          <thead>
            <tr>
              {["Driver", "Employee No", "Trips", "Total"].map((h) => <th key={h} style={thStyle}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {payrollRows.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ ...tdStyle, textAlign: "center", color: colors.textMuted }}>
                  {/* Only claim "no trips" once the month has actually loaded. */}
                  {payrollSettling ? "Loading…" : `No completed trips in ${monthKeyLabel(month)}.`}
                </td>
              </tr>
            ) : (
              payrollRows.map((d, i) => <PayrollRow key={d.driver_id} row={d} striped={i % 2 === 1} />)
            )}
          </tbody>
        </table>
      </Card>

      {/* Monthly summary table */}
      <Card pad={0}>
        <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
          <SectionTitle title="Monthly Performance Summary" subtitle={months[0]?.label + " – " + months[months.length - 1]?.label} />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Month", "Trips", "Completed", "Incentive", "External"].map((h) => <th key={h} style={thStyle}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {months.map((m: MonthlyRow, i) => (
              <tr key={m.month} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{m.label}</td>
                <td style={tdStyle}>{m.trips}</td>
                <td style={tdStyle}>{m.completed}</td>
                <td style={{ ...tdStyle, color: colors.green, fontWeight: 700 }}>{formatMoney(m.incentive)}</td>
                <td style={tdStyle}>{m.external}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Dark summary footer */}
        <div style={{ background: colors.navy, borderRadius: `0 0 ${radius.lg}px ${radius.lg}px`, padding: "16px 18px", display: "flex", justifyContent: "space-around" }}>
          <FooterStat label="Total Trips" value={formatNumber(totalTrips)} />
          <FooterStat label="Total Incentive" value={formatMoney(totalIncentive)} />
          <FooterStat label="External Trips" value={formatNumber(totalExternal)} />
        </div>
      </Card>
    </div>
  );
}

// One payroll row, expandable to the per-trip lines the month total is the
// sum of — a pay dispute is settled by reading exactly these.
function PayrollRow({ row, striped }: { row: PayrollDriverRow; striped: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        onClick={() => setOpen(!open)}
        style={{ background: striped ? colors.blueTint : "transparent", cursor: "pointer" }}
      >
        <td style={{ ...tdStyle, fontWeight: 600 }}>
          <span style={{ display: "inline-block", width: 14, color: colors.textMuted }}>{open ? "▾" : "▸"}</span>
          {row.name}
        </td>
        <td style={tdStyle}>{row.employee_number ?? "—"}</td>
        <td style={tdStyle}>{row.trip_count}</td>
        <td style={{ ...tdStyle, color: colors.green, fontWeight: 700 }}>{formatMoney(row.total)}</td>
      </tr>
      {open &&
        row.trips.map((t) => (
          <tr key={t.id} style={{ background: colors.panel }}>
            <td style={{ ...tdStyle, paddingLeft: 40, fontSize: 12.5 }} colSpan={2}>
              {t.ticket_number}
            </td>
            <td style={{ ...tdStyle, fontSize: 12.5, color: colors.textMuted }}>
              {/* The pay-deciding delivery-confirm instant (MYT). */}
              {formatDateTime(t.delivered_at ?? t.pickup_datetime)}
            </td>
            <td style={{ ...tdStyle, fontSize: 12.5 }}>{formatMoney(t.incentive_earned)}</td>
          </tr>
        ))}
    </>
  );
}

const monthSelectStyle: React.CSSProperties = {
  height: 34,
  borderRadius: radius.sm,
  border: `1px solid ${colors.border}`,
  padding: "0 8px",
  fontSize: 13,
  color: colors.text,
  background: colors.card,
};

function MiniKpi({ label, value, bg, fg }: { label: string; value: string; bg: string; fg: string }) {
  return (
    <div style={{ background: colors.card, borderRadius: radius.lg, padding: 18, border: `1px solid ${colors.border}`, borderLeft: `4px solid ${fg}`, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textMuted }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: fg, marginTop: 8 }}>{value}</div>
      <div style={{ width: 28, height: 4, background: bg, borderRadius: 2, marginTop: 8 }} />
    </div>
  );
}

function FooterStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: colors.yellow, marginTop: 4 }}>{value}</div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: colors.textMuted,
  padding: "12px 16px",
  borderBottom: `1px solid ${colors.border}`,
  background: colors.panel,
};
const tdStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.text,
  padding: "12px 16px",
  borderBottom: `1px solid ${colors.divider}`,
};
