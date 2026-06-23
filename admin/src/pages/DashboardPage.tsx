import { useNavigate } from "react-router-dom";
import { useDashboard, useDrivers, useTrips, useTrucks } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Card, KpiCard, Loading, ErrorState, ProgressBar, TripStatusBadge, SectionTitle, Pill, EmptyState } from "@/components/ui";
import { FleetMap } from "@/components/FleetMap";
import { LoadCapacityBar } from "@/components/LoadCapacityBar";
import { DispatchToggle } from "@/components/DispatchToggle";
import { relativeExpiry } from "@/lib/format";
import { ORIGIN_LABEL, tripDestination, cargoSummary, tripProgress } from "@/lib/trip";
import type { Truck } from "@/types";

const docLabel: Record<string, string> = { insurance: "Insurance", permit: "Permit", road_tax: "Road Tax" };

function alertTone(daysLeft: number) {
  if (daysLeft < 0) return { bg: colors.redTint, fg: colors.red };
  if (daysLeft <= 14) return { bg: colors.orangeTint, fg: colors.orange };
  return { bg: colors.yellowTint, fg: colors.amber };
}

export function DashboardPage() {
  const navigate = useNavigate();
  const dash = useDashboard();
  const trucks = useTrucks();
  const trips = useTrips();
  const drivers = useDrivers();

  if (dash.isLoading || trucks.isLoading) return <Loading />;
  if (dash.isError) return <ErrorState message="Could not load dashboard." onRetry={() => dash.refetch()} />;

  const k = dash.data!;
  const truckList: Truck[] = trucks.data ?? [];
  const recentTrips = (trips.data ?? []).slice(0, 6);

  // Aggregate alerts: truck doc expiries + unassigned pending bookings.
  const docAlerts = truckList.flatMap((t) =>
    t.alerts.map((a) => ({ plate: t.plate, ...a }))
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Dispatch mode toggle (Mr. Teh requirement) */}
      <Card pad={14} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <DispatchToggle />
        <span style={{ fontSize: 12.5, color: colors.textMuted }}>
          {k.pending_trips} pending {k.pending_trips === 1 ? "request" : "requests"} awaiting dispatch
        </span>
      </Card>

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <KpiCard
          label="Active Trucks"
          value={k.active_trucks}
          sub={`of ${k.total_trucks} total fleet`}
          bg={colors.blue}
          fg="#fff"
          accent="rgba(255,255,255,0.18)"
          onClick={() => navigate("/trucks")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <rect x="1" y="6" width="14" height="10" rx="2" stroke="#fff" strokeWidth="1.8" />
              <path d="M15 9h4l3 3v4h-7z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          }
        />
        <KpiCard
          label="Trips Today"
          value={k.trips_today}
          sub={`${k.trips_in_progress} in progress · ${k.completed_today} done`}
          bg={colors.yellow}
          fg={colors.navy}
          accent="rgba(0,48,135,0.12)"
          onClick={() => navigate("/trips")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" stroke={colors.navy} strokeWidth="1.8" />
              <circle cx="12" cy="10" r="2.4" stroke={colors.navy} strokeWidth="1.8" />
            </svg>
          }
        />
        <KpiCard
          label="On-Time Rate"
          value={k.on_time_rate === null ? "—" : `${k.on_time_rate}%`}
          sub="completed this month"
          bg={colors.green}
          fg="#fff"
          accent="rgba(255,255,255,0.18)"
          onClick={() => navigate("/reports")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="1.8" />
              <path d="M8 12l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
        <KpiCard
          label="Active Alerts"
          value={k.alerts}
          sub={`${docAlerts.length} doc · ${k.pending_trips} unassigned`}
          bg={colors.red}
          fg="#fff"
          accent="rgba(255,255,255,0.18)"
          onClick={() => navigate("/trucks")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l9 16H3l9-16z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 10v4M12 17v0.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          }
        />
      </div>

      {/* Map + right rail */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16, alignItems: "stretch" }}>
        <Card pad={0} style={{ overflow: "hidden", minHeight: 460, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "16px 18px", borderBottom: `1px solid ${colors.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Fleet Map — Penang &amp; Northern Region</div>
              <div style={{ fontSize: 12, color: colors.textMuted }}>Zone overlays · approximate truck positions (no live GPS yet)</div>
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: colors.textMuted }}>
              <LegendDot color={colors.green} label="Active" />
              <LegendDot color={colors.blue} label="Idle" />
              <LegendDot color={colors.orange} label="Maintenance" />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 400 }}>
            <FleetMap trucks={truckList} />
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Alerts */}
          <Card>
            <SectionTitle
              title="Fleet Alerts"
              right={<Pill bg={colors.redTint} fg={colors.red}>{docAlerts.length} active</Pill>}
            />
            {docAlerts.length === 0 ? (
              <EmptyState message="No document expiries within 30 days." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {docAlerts.map((a, i) => {
                  const tone = alertTone(a.daysLeft);
                  return (
                    <div
                      key={i}
                      style={{
                        background: tone.bg,
                        borderLeft: `3px solid ${tone.fg}`,
                        borderRadius: radius.sm,
                        padding: "9px 11px",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>
                        {a.plate} — {docLabel[a.doc]}
                      </div>
                      <div style={{ fontSize: 12, color: tone.fg, fontWeight: 600 }}>{relativeExpiry(a.daysLeft)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Live fleet load (capacity visualiser) */}
          <Card>
            <SectionTitle title="Live Fleet Load" subtitle={`${truckList.length} trucks`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {truckList.map((t) => (
                <div key={t.plate}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t.plate}</span>
                    <span style={{ fontSize: 11, color: colors.textMuted }}>{t.driver?.name ?? "Unassigned"}</span>
                  </div>
                  <LoadCapacityBar load={t.current_load} capacity={t.max_pallets} compact />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Recent trips */}
      <Card>
        <SectionTitle
          title="Recent Trips"
          subtitle="Latest bookings & deliveries"
          right={
            <button
              onClick={() => navigate("/trips")}
              style={{ border: `1.5px solid ${colors.blue}`, color: colors.blue, background: "transparent", borderRadius: radius.md, padding: "7px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
            >
              View All
            </button>
          }
        />
        {recentTrips.length === 0 ? (
          <EmptyState message="No trips yet." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Ticket", "Route", "Driver", "Cargo", "Status", "Progress"].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentTrips.map((t, i) => (
                  <tr key={t.id} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
                    <td style={{ ...tdStyle, fontWeight: 700, color: colors.blue }}>{t.ticket_number}</td>
                    <td style={tdStyle}>
                      {ORIGIN_LABEL} → {tripDestination(t)}
                    </td>
                    <td style={{ ...tdStyle, color: t.driver ? colors.text : colors.textFaint }}>
                      {t.driver?.name ?? (t.is_external ? "External forwarder" : "—")}
                    </td>
                    <td style={tdStyle}>{cargoSummary(t)}</td>
                    <td style={tdStyle}><TripStatusBadge status={t.status} /></td>
                    <td style={{ ...tdStyle, minWidth: 120 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ProgressBar pct={tripProgress(t)} color={t.status === "completed" ? colors.green : colors.blue} />
                        <span style={{ fontSize: 11.5, color: colors.textMuted, width: 32 }}>{tripProgress(t)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {drivers.data && (
        <div style={{ fontSize: 12, color: colors.textFaint }}>
          {drivers.data.filter((d) => d.status === "on_trip").length} drivers on route ·{" "}
          {drivers.data.filter((d) => d.status === "available").length} available
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: colors.textMuted,
  padding: "10px 12px",
  borderBottom: `1px solid ${colors.border}`,
};
const tdStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.text,
  padding: "12px 12px",
  borderBottom: `1px solid ${colors.divider}`,
};
