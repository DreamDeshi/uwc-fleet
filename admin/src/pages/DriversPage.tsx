import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDrivers, useDriverPerformance } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Avatar, Card, EmptyState, ErrorState, Loading, Pill, SearchInput, SegmentedFilter } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { DriverPerf, DriverPerformance, DriverStatus } from "@/types";

const STATUS_META: Record<DriverStatus, { label: string; bg: string; fg: string }> = {
  on_trip: { label: "On Trip", bg: colors.blueTint, fg: colors.blue },
  available: { label: "Available", bg: colors.greenTint, fg: colors.green },
  off_duty: { label: "Off Duty", bg: "#f3f4f6", fg: "#6b7280" },
};

// FR-FM7 — score → badge colour. green ≥75, amber 50–74, red <50.
function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}

type Filter = "all" | DriverStatus;

export function DriversPage() {
  const navigate = useNavigate();
  const drivers = useDrivers();
  const performance = useDriverPerformance();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const perfById = useMemo(() => {
    const map = new Map<string, DriverPerformance>();
    for (const p of performance.data ?? []) map.set(p.id, p);
    return map;
  }, [performance.data]);

  const counts = useMemo(() => {
    const list = drivers.data ?? [];
    return {
      all: list.length,
      on_trip: list.filter((d) => d.status === "on_trip").length,
      available: list.filter((d) => d.status === "available").length,
      off_duty: list.filter((d) => d.status === "off_duty").length,
    };
  }, [drivers.data]);

  if (drivers.isLoading) return <Loading />;
  if (drivers.isError) return <ErrorState message="Could not load drivers." onRetry={() => drivers.refetch()} />;

  const filtered = (drivers.data ?? [])
    .filter((d) => filter === "all" || d.status === filter)
    .filter((d) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.phone.includes(q) || (d.assigned_truck?.plate ?? "").toLowerCase().includes(q);
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <SegmentedFilter<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "on_trip", label: "On Trip", count: counts.on_trip },
            { value: "available", label: "Available", count: counts.available },
            { value: "off_duty", label: "Off Duty", count: counts.off_duty },
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Search drivers…" />
      </div>

      {filtered.length === 0 ? (
        <Card><EmptyState message="No drivers match this filter." /></Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
          {filtered.map((d) => (
            <DriverCard
              key={d.id}
              driver={d}
              perf={perfById.get(d.id)}
              onOpenPerf={() => navigate("/performance")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DriverCard({
  driver: d,
  perf,
  onOpenPerf,
}: {
  driver: DriverPerf;
  perf?: DriverPerformance;
  onOpenPerf: () => void;
}) {
  const meta = STATUS_META[d.status];
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Avatar name={d.name} size={46} />
        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{d.name}</div>
          <div style={{ fontSize: 12, color: colors.textMuted }}>
            {d.phone}
            {d.assigned_truck ? ` · ${d.assigned_truck.plate}` : ""}
          </div>
        </div>
        {perf && <ScoreBadge perf={perf} onClick={onOpenPerf} />}
        <Pill bg={meta.bg} fg={meta.fg}>{meta.label}</Pill>
      </div>

      <div style={{ display: "flex", border: `1px solid ${colors.divider}`, borderRadius: radius.md, overflow: "hidden" }}>
        <Stat label="Trips (total)" value={String(d.trips_total)} />
        <Stat label="This Month" value={String(d.trips_this_month)} divider />
        <Stat label="Earned (mo.)" value={formatMoney(d.incentive_this_month)} divider />
      </div>

      {d.current_route && (
        <div style={{ marginTop: 12, background: colors.blueTint, color: colors.blue, borderRadius: radius.pill, padding: "6px 12px", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" stroke={colors.blue} strokeWidth="2" /></svg>
          En route: {d.current_route}
        </div>
      )}

      {/* Scheduled (assigned-but-not-started) trips. The driver still reads
          "Available" for dispatch — only an in_progress trip marks them On Trip —
          so surface the queued count here to explain the status. */}
      {d.scheduled_trips > 0 && (
        <div style={{ marginTop: d.current_route ? 8 : 12, background: colors.panel, color: colors.textMuted, borderRadius: radius.pill, padding: "6px 12px", fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
          🗓 {d.scheduled_trips} scheduled trip{d.scheduled_trips === 1 ? "" : "s"}
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div style={{ flex: 1, padding: "10px 12px", borderLeft: divider ? `1px solid ${colors.divider}` : undefined, textAlign: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>{value}</div>
      <div style={{ fontSize: 10.5, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>{label}</div>
    </div>
  );
}

// FR-FM7 — clickable performance score badge (green ≥75, amber 50–74, red <50).
// A driver with no completed trips has nothing to score yet, so show a neutral
// grey "No data" badge rather than a misleading red 0.0.
function ScoreBadge({ perf, onClick }: { perf: DriverPerformance; onClick: () => void }) {
  if (perf.total_completed === 0) {
    return (
      <span
        title="No completed trips yet — not enough data to score"
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "#f3f4f6",
          color: "#6b7280",
          padding: "4px 10px",
          borderRadius: radius.pill,
          fontSize: 11.5,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        No data
      </span>
    );
  }

  const c = scoreColor(perf.total_score);
  return (
    <button
      onClick={onClick}
      title="Compare driver performance"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: c.bg,
        color: c.fg,
        border: "none",
        padding: "4px 10px",
        borderRadius: radius.pill,
        fontSize: 12.5,
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {perf.total_score.toFixed(1)}
      <span style={{ fontSize: 9.5, fontWeight: 700, opacity: 0.75 }}>/100</span>
    </button>
  );
}
