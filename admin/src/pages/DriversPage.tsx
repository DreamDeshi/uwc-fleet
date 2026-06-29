import { useMemo, useState } from "react";
import { useDrivers, useDriverPerformance } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Avatar, Card, EmptyState, ErrorState, Loading, Modal, Pill, ProgressBar, SearchInput, SegmentedFilter } from "@/components/ui";
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
  const drivers = useDrivers();
  const performance = useDriverPerformance();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DriverPerformance | null>(null);

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
              onOpenPerf={() => {
                const p = perfById.get(d.id);
                if (p) setSelected(p);
              }}
            />
          ))}
        </div>
      )}

      <PerformanceModal perf={selected} onClose={() => setSelected(null)} />
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
        {perf && <ScoreBadge score={perf.total_score} onClick={onOpenPerf} />}
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
function ScoreBadge({ score, onClick }: { score: number; onClick: () => void }) {
  const c = scoreColor(score);
  return (
    <button
      onClick={onClick}
      title="View performance breakdown"
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
      {score.toFixed(1)}
      <span style={{ fontSize: 9.5, fontWeight: 700, opacity: 0.75 }}>/100</span>
    </button>
  );
}

const COMPONENT_META = [
  {
    key: "on_time" as const,
    label: "On-time rate",
    weight: 40,
    blurb: "Share of completed trips delivered the same day they were picked up.",
  },
  {
    key: "completion" as const,
    label: "Trip completion",
    weight: 30,
    blurb: "Completed trips as a share of all trips assigned (completed + cancelled).",
  },
  {
    key: "points" as const,
    label: "Incentive earned",
    weight: 30,
    blurb: "This month's incentive, scaled against the fleet's top earner.",
  },
];

// FR-FM7 — breakdown of the three score components and what each one means.
function PerformanceModal({ perf, onClose }: { perf: DriverPerformance | null; onClose: () => void }) {
  if (!perf) return null;
  const rows = [
    { ...COMPONENT_META[0], score: perf.on_time_component, detail: `${perf.on_time_rate.toFixed(1)}% on time` },
    { ...COMPONENT_META[1], score: perf.completion_component, detail: `${perf.completion_rate.toFixed(1)}% completed` },
    { ...COMPONENT_META[2], score: perf.points_component, detail: formatMoney(perf.points_this_month) + " this month" },
  ];
  const badge = scoreColor(perf.total_score);

  return (
    <Modal open onClose={onClose} title={`${perf.name} — Performance`} width={480}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <div
          style={{
            background: badge.bg,
            color: badge.fg,
            borderRadius: radius.md,
            padding: "10px 16px",
            fontSize: 30,
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          {perf.total_score.toFixed(1)}
          <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.7 }}> /100</span>
        </div>
        <div style={{ fontSize: 12.5, color: colors.textMuted }}>
          {perf.employee_number ? `Emp #${perf.employee_number}` : "No employee number"}
          {perf.truck_plate ? ` · ${perf.truck_plate}` : ""}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {rows.map((r) => (
          <div key={r.key}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.text }}>
                {r.label}
                <span style={{ fontSize: 11.5, fontWeight: 600, color: colors.textFaint }}> ({r.weight}%)</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: colors.text }}>
                {r.score.toFixed(1)}
                <span style={{ fontSize: 11, color: colors.textFaint }}> / {r.weight}</span>
              </div>
            </div>
            <ProgressBar pct={(r.score / r.weight) * 100} />
            <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 6 }}>
              {r.detail} — {r.blurb}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
