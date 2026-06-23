import { useMemo, useState } from "react";
import { useTrucks } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Avatar, Card, EmptyState, ErrorState, Loading, Pill, SearchInput, SegmentedFilter } from "@/components/ui";
import { LoadCapacityBar } from "@/components/LoadCapacityBar";
import { formatDate, formatMoney } from "@/lib/format";
import type { Truck, TruckAlert } from "@/types";

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  active: { label: "Active", bg: colors.greenTint, fg: colors.green },
  idle: { label: "Idle", bg: colors.blueTint, fg: colors.blue },
  maintenance: { label: "Maintenance", bg: colors.orangeTint, fg: colors.orange },
};

type Filter = "all" | "active" | "idle" | "maintenance";

export function TrucksPage() {
  const trucks = useTrucks();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    const list = trucks.data ?? [];
    return {
      all: list.length,
      active: list.filter((t) => t.status === "active").length,
      idle: list.filter((t) => t.status === "idle").length,
      maintenance: list.filter((t) => t.status === "maintenance").length,
    };
  }, [trucks.data]);

  if (trucks.isLoading) return <Loading />;
  if (trucks.isError) return <ErrorState message="Could not load trucks." onRetry={() => trucks.refetch()} />;

  const list = trucks.data ?? [];
  const withAlerts = list.filter((t) => t.alerts.length > 0).length;

  const filtered = list
    .filter((t) => filter === "all" || t.status === filter)
    .filter((t) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return t.plate.toLowerCase().includes(q) || (t.driver?.name ?? "").toLowerCase().includes(q);
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {withAlerts > 0 && (
        <div style={{ background: colors.orangeTint, border: `1px solid #FFB74D`, borderRadius: radius.md, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3l9-16z" stroke={colors.orange} strokeWidth="1.8" strokeLinejoin="round" /><path d="M12 10v4M12 17v.5" stroke={colors.orange} strokeWidth="1.8" strokeLinecap="round" /></svg>
          <span style={{ fontSize: 13.5, color: colors.text }}>
            <strong>{withAlerts} truck{withAlerts === 1 ? "" : "s"}</strong> have document expiries within 30 days.
          </span>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <SegmentedFilter<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "active", label: "Active", count: counts.active },
            { value: "idle", label: "Idle", count: counts.idle },
            { value: "maintenance", label: "Maintenance", count: counts.maintenance },
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Search trucks…" />
      </div>

      {filtered.length === 0 ? (
        <Card><EmptyState message="No trucks match this filter." /></Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
          {filtered.map((t) => (
            <TruckCard key={t.plate} truck={t} />
          ))}
        </div>
      )}
    </div>
  );
}

const truckGlyph = (
  <svg width="20" height="14" viewBox="0 0 24 16" fill="none">
    <rect x="0" y="2" width="15" height="11" rx="2" fill={colors.yellow} />
    <path d="M15 5h5l4 4v4h-9z" fill={colors.yellow} />
  </svg>
);

function TruckCard({ truck: t }: { truck: Truck }) {
  const meta = STATUS_META[t.status] ?? STATUS_META.idle;
  const hasAlert = t.alerts.length > 0;
  return (
    <Card style={hasAlert ? { border: `1px solid #FFB74D`, boxShadow: "0 2px 12px rgba(249,115,22,0.12)" } : undefined}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Avatar size={46} glyph={truckGlyph} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 0.3 }}>{t.plate}</div>
          <div style={{ fontSize: 12, color: colors.textMuted }}>{t.type} · {t.max_pallets} pallets</div>
        </div>
        <Pill bg={meta.bg} fg={meta.fg}>{meta.label}</Pill>
      </div>

      {/* Load visualiser */}
      <div style={{ marginBottom: 14 }}>
        <LoadCapacityBar load={t.current_load} capacity={t.max_pallets} />
      </div>

      {/* Stats */}
      <div style={{ display: "flex", border: `1px solid ${colors.divider}`, borderRadius: radius.md, overflow: "hidden", marginBottom: 12 }}>
        <Mini label="Trips Today" value={String(t.trips_today)} />
        <Mini label="Driver" value={t.driver?.name?.split(" ")[0] ?? "None"} divider />
        <Mini label="Zone" value={t.priority_zones[0] ?? "—"} divider />
      </div>

      {/* Claim rates */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <RatePill label="Weekday" value={formatMoney(t.entitled_claim_weekday)} color={colors.blue} bg={colors.blueTint} />
        <RatePill label="Weekend" value={formatMoney(t.entitled_claim_offpeak)} color={colors.amber} bg={colors.yellowTint} />
        <RatePill label="Deduction" value={`${t.daily_deduction_points} pts`} color={colors.red} bg={colors.redTint} />
      </div>

      {/* Documents */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <DocRow label="Insurance" date={t.insurance_expiry} alert={findAlert(t.alerts, "insurance")} />
        <DocRow label="Permit" date={t.permit_expiry} alert={findAlert(t.alerts, "permit")} />
        <DocRow label="Road Tax" date={t.road_tax_expiry} alert={findAlert(t.alerts, "road_tax")} />
      </div>
    </Card>
  );
}

function findAlert(alerts: TruckAlert[], doc: TruckAlert["doc"]) {
  return alerts.find((a) => a.doc === doc);
}

function DocRow({ label, date, alert }: { label: string; date: string | null; alert?: TruckAlert }) {
  const flagged = !!alert;
  const color = !flagged ? colors.text : alert!.daysLeft < 0 ? colors.red : colors.orange;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
      <span style={{ color: colors.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
        {flagged && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3l9-16z" stroke={color} strokeWidth="2" strokeLinejoin="round" /></svg>
        )}
        {label}
      </span>
      <span style={{ color, fontWeight: flagged ? 700 : 500 }}>
        {formatDate(date)}
        {flagged && (alert!.daysLeft < 0 ? " · expired" : ` · ${alert!.daysLeft}d`)}
      </span>
    </div>
  );
}

function Mini({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div style={{ flex: 1, padding: "9px 10px", borderLeft: divider ? `1px solid ${colors.divider}` : undefined, textAlign: "center" }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      <div style={{ fontSize: 10, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function RatePill({ label, value, color, bg }: { label: string; value: string; color: string; bg: string }) {
  return (
    <div style={{ flex: 1, background: bg, borderRadius: radius.sm, padding: "8px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 10, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}
