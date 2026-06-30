import { useMemo } from "react";
import { useDriverPerformance } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Card, EmptyState, ErrorState, Loading, Pill, ProgressBar } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { DriverPerformance } from "@/types";

// FR-FM7 — score → badge colour. green ≥75, amber 50–74, red <50 (mirrors the
// Driver Management card badge so the two pages read the same).
function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}

const tierFor = (s: number) => (s >= 75 ? "Gold" : s >= 50 ? "Silver" : "Bronze");

// Admin comparison view — every driver across three lenses (reliability,
// productivity, workload) plus a ranked leaderboard that exposes the
// un-blended score components so admin sees WHY each driver ranks where it does.
export function PerformancePage() {
  const performance = useDriverPerformance();

  const ranked = useMemo(
    () => [...(performance.data ?? [])].sort((a, b) => b.total_score - a.total_score),
    [performance.data]
  );

  if (performance.isLoading) return <Loading />;
  if (performance.isError)
    return <ErrorState message="Could not load performance data." onRetry={() => performance.refetch()} />;
  if (ranked.length === 0)
    return (
      <Card>
        <EmptyState message="No drivers to compare yet." />
      </Card>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontSize: 13, color: colors.textMuted, lineHeight: 1.5 }}>
        Compare every driver across <strong>reliability</strong>, <strong>productivity</strong> and{" "}
        <strong>workload</strong>. The leaderboard below breaks the score into its three weighted
        parts (on-time 40 · completion 30 · incentive 30) so a ranking is never a black box.
      </div>

      <Leaderboard ranked={ranked} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Reliability drivers={ranked} />
        <Productivity drivers={ranked} />
      </div>

      <Workload drivers={ranked} />
    </div>
  );
}

// ── Lens section shell ──────────────────────────────────────────────────
function Lens({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.2, color: colors.blue, textTransform: "uppercase" }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 3 }}>{hint}</div>
      </div>
      {children}
    </Card>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 10.5,
  fontWeight: 700,
  color: colors.textFaint,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  padding: "8px 10px",
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.text,
  padding: "10px 10px",
  borderBottom: `1px solid ${colors.divider}`,
};

function DriverCell({ d }: { d: DriverPerformance }) {
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{d.name}</div>
      <div style={{ fontSize: 11, color: colors.textFaint }}>
        {d.employee_number ? `#${d.employee_number}` : "—"}
        {d.truck_plate ? ` · ${d.truck_plate}` : ""}
      </div>
    </div>
  );
}

function ScoreBadge({ score, completed }: { score: number; completed: number }) {
  if (completed === 0) {
    return (
      <span style={{ background: "#f3f4f6", color: "#6b7280", padding: "3px 9px", borderRadius: radius.pill, fontSize: 11.5, fontWeight: 700 }}>
        No data
      </span>
    );
  }
  const c = scoreColor(score);
  return (
    <span style={{ background: c.bg, color: c.fg, padding: "3px 9px", borderRadius: radius.pill, fontSize: 12.5, fontWeight: 800, whiteSpace: "nowrap" }}>
      {score.toFixed(1)}
      <span style={{ fontSize: 9.5, fontWeight: 700, opacity: 0.7 }}>/100</span>
    </span>
  );
}

// ── Ranked leaderboard — the "why" view, sorted by total score ───────────
function Leaderboard({ ranked }: { ranked: DriverPerformance[] }) {
  return (
    <Lens
      title="Ranked Leaderboard"
      hint="Highest score first, with each weighted component shown so the ranking is explainable."
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 36 }}>#</th>
              <th style={thStyle}>Driver</th>
              <th style={thStyle}>Score</th>
              <th style={thStyle}>Tier</th>
              <th style={thStyle}>On-time (/40)</th>
              <th style={thStyle}>Completion (/30)</th>
              <th style={thStyle}>Incentive (/30)</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((d, i) => {
              const scored = d.total_completed > 0;
              return (
                <tr key={d.id}>
                  <td style={{ ...tdStyle, fontWeight: 800, color: colors.textFaint }}>{i + 1}</td>
                  <td style={tdStyle}>
                    <DriverCell d={d} />
                  </td>
                  <td style={tdStyle}>
                    <ScoreBadge score={d.total_score} completed={d.total_completed} />
                  </td>
                  <td style={tdStyle}>
                    {scored ? (
                      <Pill {...tierPill(d.total_score)}>{tierFor(d.total_score)}</Pill>
                    ) : (
                      <span style={{ color: colors.textFaint }}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Component value={d.on_time_component} max={40} detail={`${d.on_time_rate.toFixed(0)}% on time`} />
                  </td>
                  <td style={tdStyle}>
                    <Component value={d.completion_component} max={30} detail={`${d.completion_rate.toFixed(0)}% completed`} />
                  </td>
                  <td style={tdStyle}>
                    <Component value={d.points_component} max={30} detail={formatMoney(d.rm_earned_this_month)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Lens>
  );
}

function tierPill(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}

function Component({ value, max, detail }: { value: number; max: number; detail: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
        <span>
          {value.toFixed(1)}
          <span style={{ color: colors.textFaint, fontWeight: 600 }}> / {max}</span>
        </span>
        <span style={{ color: colors.textMuted, fontWeight: 600, fontSize: 11 }}>{detail}</span>
      </div>
      <ProgressBar pct={(value / max) * 100} />
    </div>
  );
}

// ── Reliability lens — on-time % and completion % ────────────────────────
function Reliability({ drivers }: { drivers: DriverPerformance[] }) {
  return (
    <Lens title="Reliability" hint="On-time delivery and trip completion — did the job land as planned?">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Driver</th>
            <th style={{ ...thStyle, textAlign: "right" }}>On-time</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Completion</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d) => (
            <tr key={d.id}>
              <td style={tdStyle}>
                <DriverCell d={d} />
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700 }}>
                {d.total_completed > 0 ? `${d.on_time_rate.toFixed(0)}%` : "—"}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700 }}>
                {d.total_completed + d.total_cancelled > 0 ? `${d.completion_rate.toFixed(0)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Lens>
  );
}

// ── Productivity lens — output volume ────────────────────────────────────
function Productivity({ drivers }: { drivers: DriverPerformance[] }) {
  return (
    <Lens title="Productivity" hint="Volume of work delivered — trips, incentive points and distance this month.">
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Driver</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Trips (all)</th>
            <th style={{ ...thStyle, textAlign: "right" }}>RM (mo.)</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Dist (mo.)</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d) => (
            <tr key={d.id}>
              <td style={tdStyle}>
                <DriverCell d={d} />
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700 }}>{d.total_completed}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700 }}>{formatMoney(d.rm_earned_this_month)}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontWeight: 700 }}>{Math.round(d.distance_km_this_month)} km</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Lens>
  );
}

// ── Workload lens — trips this month as a bar chart + balance note ───────
function Workload({ drivers }: { drivers: DriverPerformance[] }) {
  const byLoad = [...drivers].sort((a, b) => b.completed_this_month - a.completed_this_month);
  const max = Math.max(...byLoad.map((d) => d.completed_this_month), 0);
  const most = byLoad[0];
  const least = byLoad[byLoad.length - 1];

  const note =
    max === 0
      ? "No trips have been completed yet this month — nothing to balance."
      : most.completed_this_month === least.completed_this_month
      ? `Work is evenly spread — every driver completed ${most.completed_this_month} trip(s) this month.`
      : `${most.name} is carrying the most this month (${most.completed_this_month} trips), while ${least.name} has the fewest (${least.completed_this_month}). Consider rebalancing.`;

  return (
    <Lens title="Workload" hint="Trips completed this month per driver — spot an overloaded or idle driver at a glance.">
      <div
        style={{
          background: max > 0 && most.completed_this_month !== least.completed_this_month ? colors.orangeTint : colors.blueTint,
          color: max > 0 && most.completed_this_month !== least.completed_this_month ? colors.orange : colors.blue,
          borderRadius: radius.md,
          padding: "10px 14px",
          fontSize: 12.5,
          fontWeight: 600,
          marginBottom: 16,
        }}
      >
        {note}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {byLoad.map((d) => {
          const pct = max > 0 ? (d.completed_this_month / max) * 100 : 0;
          const isMost = max > 0 && d.completed_this_month === most.completed_this_month;
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 150, fontSize: 12.5, fontWeight: 600, color: colors.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {d.name}
              </div>
              <div style={{ flex: 1, background: colors.divider, borderRadius: radius.pill, height: 22, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${pct}%`,
                    minWidth: d.completed_this_month > 0 ? 24 : 0,
                    height: "100%",
                    background: isMost ? colors.blue : "#7da7e0",
                    borderRadius: radius.pill,
                    transition: "width .3s",
                  }}
                />
              </div>
              <div style={{ width: 28, textAlign: "right", fontSize: 13, fontWeight: 800, color: colors.navy }}>
                {d.completed_this_month}
              </div>
            </div>
          );
        })}
      </div>
    </Lens>
  );
}
