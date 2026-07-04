import { lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useAttention, useDashboard, useDrivers, useFleetLive, useTrips, useTrucks } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Card, KpiCard, Loading, ErrorState, ProgressBar, TripStatusBadge, SectionTitle, Pill, EmptyState } from "@/components/ui";
// FleetMap pulls in Leaflet (~150 KB). It sits below the fold on the dashboard,
// so we load it as its own chunk and let the KPIs paint first.
const FleetMap = lazy(() => import("@/components/FleetMap").then((m) => ({ default: m.FleetMap })));
import { LoadCapacityBar } from "@/components/LoadCapacityBar";
import { DispatchToggle } from "@/components/DispatchToggle";
import { relativeExpiry } from "@/lib/format";
import { ORIGIN_LABEL, tripDestination, cargoSummary, tripProgress } from "@/lib/trip";
import type { AttentionTrip, Truck } from "@/types";

const docLabel: Record<string, string> = { insurance: "Insurance", permit: "Permit", road_tax: "Road Tax" };

// ── Stuck/stale trips (read-only attention report) ──────────────────────
// The needs-attention flag only covers PENDING trips; this card surfaces the
// three previously-invisible states from GET /reports/attention. Renders
// nothing when the fleet is healthy.
function AttentionPanel({
  report,
  onOpenTrips,
}: {
  report?: import("@/types").AttentionReport;
  onOpenTrips: () => void;
}) {
  if (!report) return null;
  const groups: { title: string; hint: string; rows: AttentionTrip[] }[] = [
    {
      title: "In progress too long",
      hint: `pickup > ${report.thresholds.staleInProgressHours}h ago, still not completed`,
      rows: report.stale_in_progress,
    },
    {
      title: "Assigned but never started",
      hint: `pickup > ${report.thresholds.overdueAssignedHours}h ago, driver hasn't started`,
      rows: report.overdue_assigned,
    },
    {
      title: "Completed with no incentive recorded",
      hint: "legacy anomaly — pay was never computed for these",
      rows: report.completed_null_incentive,
    },
    {
      title: "Driver now on leave — reassign",
      hint: "assigned trips whose driver has leave covering the pickup date",
      rows: report.assigned_driver_on_leave ?? [],
    },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;

  return (
    <Card pad={0} style={{ border: `1px solid #FFB74D` }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${colors.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionTitle title="⚠ Trips needing attention" subtitle="stuck or stale — auto-refreshes every minute" />
        <button onClick={onOpenTrips} style={{ background: "none", border: "none", color: colors.blue, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
          Open trip board →
        </button>
      </div>
      <div style={{ padding: "10px 18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {groups.map((g) => (
          <div key={g.title}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: colors.orange, marginBottom: 4 }}>
              {g.title} · {g.rows.length}
              <span style={{ fontWeight: 500, color: colors.textFaint }}> ({g.hint})</span>
            </div>
            {g.rows.slice(0, 5).map((t) => (
              <div key={t.id} style={{ fontSize: 12.5, color: colors.text, padding: "3px 0", display: "flex", gap: 8 }}>
                <span style={{ fontWeight: 700 }}>{t.ticket_number}</span>
                <span style={{ color: colors.textMuted }}>
                  {t.driver?.name ?? "—"}
                  {t.truck_plate ? ` · ${t.truck_plate}` : ""} ·{" "}
                  {/* Leave collisions are usually FUTURE pickups — show "until". */}
                  {Math.abs(Math.round(t.hours_since_pickup))}h{" "}
                  {t.hours_since_pickup >= 0 ? "since" : "until"} pickup
                </span>
              </div>
            ))}
            {g.rows.length > 5 && (
              <div style={{ fontSize: 12, color: colors.textFaint }}>… and {g.rows.length - 5} more</div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

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
  const live = useFleetLive();
  const attention = useAttention();

  if (dash.isLoading || trucks.isLoading) return <Loading />;
  if (dash.isError) return <ErrorState message="Could not load dashboard." onRetry={() => dash.refetch()} />;

  const k = dash.data!;
  const truckList: Truck[] = trucks.data ?? [];
  const recentTrips = (trips.data ?? []).slice(0, 6);
  const liveCount = (live.data ?? []).filter((p) => !p.stale).length;

  // Aggregate alerts: truck doc expiries + unassigned pending bookings.
  const docAlerts = truckList.flatMap((t) =>
    t.alerts.map((a) => ({ plate: t.plate, ...a }))
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Dispatch mode toggle (Mr. Teh requirement) */}
      <Card pad={14} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <DispatchToggle />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Auto-dispatch failures get their OWN, distinct signal — never folded
              into the plain "awaiting manual" count (Phase 2). */}
          {k.auto_dispatch_failed > 0 && (
            <button
              onClick={() => navigate("/trips?attention=1")}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, background: colors.redTint, color: colors.red, border: `1px solid ${colors.red}`, borderRadius: radius.pill, padding: "5px 11px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
            >
              ⚠ {k.auto_dispatch_failed} auto-dispatch failed
            </button>
          )}
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>
            {k.awaiting_manual} awaiting manual dispatch
          </span>
        </div>
      </Card>

      <AttentionPanel report={attention.data} onOpenTrips={() => navigate("/trips")} />

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
          sub={`${docAlerts.length} doc · ${k.auto_dispatch_failed} failed · ${k.awaiting_manual} awaiting`}
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
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Zone overlays ·{" "}
                {liveCount > 0
                  ? `${liveCount} truck${liveCount === 1 ? "" : "s"} live on GPS`
                  : "approximate positions (awaiting GPS)"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: colors.textMuted }}>
              <LegendDot color={colors.green} label="Active" />
              <LegendDot color={colors.blue} label="Idle" />
              <LegendDot color={colors.orange} label="Maintenance" />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 400 }}>
            <Suspense
              fallback={
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: colors.textMuted, fontSize: 13 }}>
                  Loading map…
                </div>
              }
            >
              <FleetMap trucks={truckList} live={live.data ?? []} />
            </Suspense>
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
