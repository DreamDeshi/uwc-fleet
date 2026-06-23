import { useMemo } from "react";
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
import { useDrivers, useMonthly, useTrips } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, ErrorState, Loading, SectionTitle } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/format";
import type { DriverPerf, MonthlyRow } from "@/types";

const PIE_COLORS = [colors.blue, colors.yellow, colors.green, colors.orange, "#9333ea", "#0891b2"];

export function ReportsPage() {
  const monthly = useMonthly();
  const drivers = useDrivers();
  const trips = useTrips();

  const routeSplit = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trips.data ?? []) {
      map.set(t.route_type.name, (map.get(t.route_type.name) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, value]) => ({ name, value }));
  }, [trips.data]);

  if (monthly.isLoading || drivers.isLoading) return <Loading />;
  if (monthly.isError) return <ErrorState message="Could not load reports." onRetry={() => monthly.refetch()} />;

  const months = monthly.data ?? [];
  const driverRows = (drivers.data ?? []).slice().sort((a, b) => b.incentive_this_month - a.incentive_this_month);

  const totalTrips = months.reduce((s, m) => s + m.trips, 0);
  const totalIncentive = months.reduce((s, m) => s + m.incentive, 0);
  const totalExternal = months.reduce((s, m) => s + m.external, 0);
  const avgTrip = (() => {
    const completed = months.reduce((s, m) => s + m.completed, 0);
    return completed ? totalIncentive / completed : 0;
  })();

  function exportCsv() {
    const header = ["Month", "Trips", "Completed", "Incentive (RM)", "External"];
    const rows = months.map((m) => [m.label, m.trips, m.completed, m.incentive, m.external]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "uwc-monthly-report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="primary" size="sm" onClick={exportCsv}>
          ⬇ Export CSV
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

      {/* Driver performance table */}
      <Card pad={0}>
        <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
          <SectionTitle title="Driver Incentive Summary" subtitle="This month" />
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Driver", "Trips (mo.)", "Trips (total)", "Earned (mo.)", "Avg / Trip"].map((h) => <th key={h} style={thStyle}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {driverRows.map((d: DriverPerf, i) => (
              <tr key={d.id} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{d.name}</td>
                <td style={tdStyle}>{d.trips_this_month}</td>
                <td style={tdStyle}>{d.trips_total}</td>
                <td style={{ ...tdStyle, color: colors.green, fontWeight: 700 }}>{formatMoney(d.incentive_this_month)}</td>
                <td style={tdStyle}>{formatMoney(d.trips_this_month ? d.incentive_this_month / d.trips_this_month : 0)}</td>
              </tr>
            ))}
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
