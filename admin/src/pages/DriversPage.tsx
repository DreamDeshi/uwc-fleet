import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAddLeave, useDeleteLeave, useDrivers, useDriverPerformance, useLeaves } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Avatar, Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Pill, SearchInput, SectionTitle, SegmentedFilter } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { apiErrorMessage } from "@/services/api";
import type { DriverLeaveEntry, DriverPerf, DriverPerformance, DriverStatus } from "@/types";

// Driver status wears the same badge language as trip statuses: tinted
// fill, dot, and an accent used as the card's left bar.
const STATUS_META: Record<DriverStatus, { label: string; bg: string; fg: string; dot: string }> = {
  on_trip: { label: "On Trip", bg: colors.blueTint, fg: colors.blue, dot: "#2563EB" },
  available: { label: "Available", bg: colors.greenTint, fg: "#2E7D32", dot: colors.green },
  off_duty: { label: "Off Duty", bg: "#f3f4f6", fg: "#4B5563", dot: "#9CA3AF" },
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

      <LeaveManager drivers={drivers.data ?? []} />
    </div>
  );
}

// ── Driver leave (tracker #4) ─────────────────────────────────────────
// Date-based availability: a driver on leave for a trip's pickup date is
// excluded from auto-dispatch and blocked in the dispatch panel for that date,
// while keeping their login and their trips on other dates. NOT the same as
// disabling the account (which revokes access entirely).
function LeaveManager({ drivers }: { drivers: DriverPerf[] }) {
  const leaves = useLeaves();
  const [deleting, setDeleting] = useState<DriverLeaveEntry | null>(null);

  return (
    <Card pad={0}>
      <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
        <SectionTitle
          title="Driver Leave"
          subtitle="A driver on leave is skipped by dispatch for those dates — login stays active"
        />
        <AddLeaveForm drivers={drivers} />
      </div>
      {leaves.isLoading ? (
        <div style={{ padding: 18 }}><Loading /></div>
      ) : leaves.isError ? (
        <div style={{ padding: 18 }}>
          <ErrorState message="Could not load leave entries." onRetry={() => leaves.refetch()} />
        </div>
      ) : (leaves.data ?? []).length === 0 ? (
        <div style={{ padding: 20, fontSize: 14, color: colors.textMuted }}>
          No leave recorded — every active driver is in the dispatch pool.
        </div>
      ) : (
        <table className="uwc-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: colors.panel }}>{["Driver", "From", "To", "Note", ""].map((h) => (
              <th key={h} style={{ textAlign: "left", fontSize: 11, fontWeight: 800, letterSpacing: 0.7, textTransform: "uppercase", color: "#475467", padding: "11px 20px", borderBottom: `1px solid ${colors.border}` }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {leaves.data!.map((l) => (
              <tr key={l.id}>
                <td style={leaveTd}>
                  <span style={{ fontWeight: 700 }}>{l.driver.name}</span>
                  {l.driver.assigned_truck_plate ? ` · ${l.driver.assigned_truck_plate}` : ""}
                </td>
                <td style={leaveTd}>{formatDate(l.start_date)}</td>
                <td style={leaveTd}>{l.end_date === l.start_date ? "—" : formatDate(l.end_date)}</td>
                <td style={{ ...leaveTd, color: colors.textMuted }}>{l.note ?? ""}</td>
                <td style={{ ...leaveTd, textAlign: "right" }}>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(l)}>Remove</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleting && <DeleteLeaveConfirm leave={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  );
}

const leaveTd: React.CSSProperties = {
  fontSize: 14,
  color: colors.text,
  padding: "13px 20px",
  borderBottom: `1px solid ${colors.divider}`,
};

function AddLeaveForm({ drivers }: { drivers: DriverPerf[] }) {
  const [driverId, setDriverId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useAddLeave();

  async function submit() {
    setError(null);
    if (!driverId || !start) {
      setError("Pick a driver and at least the start date.");
      return;
    }
    try {
      await add.mutateAsync({
        driver_id: driverId,
        start_date: start,
        end_date: end || undefined,
        note: note.trim() || undefined,
      });
      setDriverId("");
      setStart("");
      setEnd("");
      setNote("");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not add the leave entry."));
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>Driver</div>
          <select
            className="uwc-input"
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            style={{ padding: "11px 13px", borderRadius: radius.md, border: `1px solid ${colors.border}`, fontSize: 14, minWidth: 220, background: colors.card, color: colors.text, outline: "none" }}
          >
            <option value="">Select a driver…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.assigned_truck ? ` (${d.assigned_truck.plate})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div style={{ width: 170, marginBottom: -14 }}>
          <Input label="From" value={start} onChange={setStart} type="date" />
        </div>
        <div style={{ width: 170, marginBottom: -14 }}>
          <Input label="To (optional)" value={end} onChange={setEnd} type="date" />
        </div>
        <div style={{ flex: 1, minWidth: 160, marginBottom: -14 }}>
          <Input label="Note (optional)" value={note} onChange={setNote} placeholder="e.g. Annual leave" />
        </div>
        <Button variant="primary" onClick={submit} disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add leave"}
        </Button>
      </div>
    </div>
  );
}

// Removing leave puts the driver straight back into the dispatch pool for
// those dates — confirm before firing (audit-logged server-side).
function DeleteLeaveConfirm({ leave, onClose }: { leave: DriverLeaveEntry; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const del = useDeleteLeave();

  async function doDelete() {
    setError(null);
    try {
      await del.mutateAsync(leave.id);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not remove the leave entry."));
    }
  }

  const range =
    leave.end_date === leave.start_date
      ? formatDate(leave.start_date)
      : `${formatDate(leave.start_date)} – ${formatDate(leave.end_date)}`;

  return (
    <Modal open onClose={onClose} title="Remove this leave entry?" width={420}>
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 14 }}>
        Remove <strong>{leave.driver.name}</strong>'s leave ({range})? The driver goes
        straight back into the dispatch pool for those dates.
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="ghost" full onClick={onClose} disabled={del.isPending}>Cancel</Button>
        <Button variant="danger" full onClick={doDelete} disabled={del.isPending}>
          {del.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
    </Modal>
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
    <Card style={{ borderLeft: `5px solid ${meta.dot}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Avatar name={d.name} size={46} />
        <div style={{ flex: 1, overflow: "hidden" }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{d.name}</div>
          <div style={{ fontSize: 13, color: colors.textMuted }}>
            {d.phone}
            {d.assigned_truck ? ` · ${d.assigned_truck.plate}` : ""}
          </div>
        </div>
        {perf && <ScoreBadge perf={perf} onClick={onOpenPerf} />}
        {/* Leave is date-scoped, so it's a badge alongside status, not a status:
            an on-leave-today driver can still hold trips for other dates. */}
        {d.on_leave_today && <Pill bg={colors.yellowTint} fg={colors.amber} dot={colors.orange}>On leave</Pill>}
        <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot}>{meta.label}</Pill>
      </div>

      <div style={{ display: "flex", background: colors.panel, border: `1px solid ${colors.divider}`, borderRadius: radius.md, overflow: "hidden" }}>
        <Stat label="Trips (total)" value={String(d.trips_total)} />
        <Stat label="This Month" value={String(d.trips_this_month)} divider />
        <Stat label="Earned (mo.)" value={formatMoney(d.incentive_this_month)} divider />
      </div>

      {d.current_route && (
        <div style={{ marginTop: 12, background: colors.blueTint, color: colors.blue, borderRadius: radius.pill, padding: "6px 12px", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z" stroke={colors.blue} strokeWidth="2" /></svg>
          En route: {d.current_route}
        </div>
      )}

      {/* Scheduled (assigned-but-not-started) trips. The driver still reads
          "Available" for dispatch — only an in_progress trip marks them On Trip —
          so surface the queued count here to explain the status. */}
      {d.scheduled_trips > 0 && (
        <div style={{ marginTop: d.current_route ? 8 : 12, background: colors.panel, color: colors.textMuted, borderRadius: radius.pill, padding: "6px 12px", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
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
      <div style={{ fontSize: 11.5, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>{label}</div>
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
          fontSize: 12,
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
        fontSize: 13,
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {perf.total_score.toFixed(1)}
      <span style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.75 }}>/100</span>
    </button>
  );
}
