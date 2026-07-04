import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useApproveTrip,
  useAssignExternal,
  useCancelTrip,
  useDrivers,
  useRejectTrip,
  useReassignTrip,
  useTrip,
  useTrips,
  useUnassignTrip,
} from "@/hooks/queries";
import { colors, radius } from "@/theme";
import {
  Avatar,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  Pill,
  ProgressBar,
  SearchInput,
  SegmentedFilter,
  TripStatusBadge,
} from "@/components/ui";
import { DispatchToggle } from "@/components/DispatchToggle";
import { StatusTimeline } from "@/components/StatusTimeline";
import { apiErrorMessage, apiErrorCode, apiErrorConflicts } from "@/services/api";
import { formatDateTime, formatMoney, mytDateKey } from "@/lib/format";
import { byPickupUrgency } from "@/lib/pendingOrder";
import {
  ORIGIN_LABEL,
  cargoSummary,
  totalPallets,
  tripConsigneeName,
  tripDestination,
  tripGroup,
  tripProgress,
} from "@/lib/trip";
import type { Trip, SchedulingConflictInfo } from "@/types";

const GROUP_ORDER = ["pending", "active", "completed", "cancelled"] as const;
const GROUP_META: Record<string, { label: string; dot: string }> = {
  pending: { label: "Pending Dispatch", dot: colors.orange },
  active: { label: "Active", dot: colors.green },
  completed: { label: "Completed", dot: colors.blue },
  cancelled: { label: "Cancelled / Rejected", dot: "#9ca3af" },
};

// The 7 fixed delivery zones (Zone model @id codes).
const ZONES = ["P1", "P2", "P3", "K1", "K2", "A1", "A2"];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// Native select / date input styled to match the shared Input/SearchInput look.
const controlStyle: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: radius.md,
  border: `1px solid ${colors.border}`,
  fontSize: 14,
  outline: "none",
  color: colors.text,
  background: colors.card,
};

export function TripsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Filters. The free-text box is debounced (300ms) so we don't hit the API on
  // every keystroke; the rest apply immediately.
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");
  const [driverId, setDriverId] = useState("");
  const [zone, setZone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Phase 2: show ONLY pending bookings the auto-dispatcher couldn't place.
  // The dashboard's "⚠ N auto-dispatch failed" badge deep-links here with
  // ?attention=1 so the click lands directly on the filtered view instead of
  // dumping the dispatcher on the full board to find the chip themselves.
  const [searchParams] = useSearchParams();
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(
    searchParams.get("attention") === "1"
  );

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const trips = useTrips({
    q: debouncedQ,
    status,
    driver_id: driverId,
    zone,
    date_from: dateFrom,
    date_to: dateTo,
  });
  const drivers = useDrivers();

  const hasFilters = !!(q || status || driverId || zone || dateFrom || dateTo || needsAttentionOnly);
  const clearFilters = () => {
    setQ("");
    setDebouncedQ("");
    setStatus("");
    setDriverId("");
    setZone("");
    setDateFrom("");
    setDateTo("");
    setNeedsAttentionOnly(false);
  };

  // A booking "needs attention" when it's still pending AND auto-dispatch failed
  // to place it — the persistent, self-clearing Phase-2 signal.
  const needsAttention = (t: Trip) => t.status === "pending" && t.auto_dispatch_failed;
  const attentionCount = useMemo(
    () => (trips.data ?? []).filter(needsAttention).length,
    [trips.data]
  );

  const grouped = useMemo(() => {
    const g: Record<string, Trip[]> = { pending: [], active: [], completed: [], cancelled: [] };
    const source = needsAttentionOnly ? (trips.data ?? []).filter(needsAttention) : trips.data ?? [];
    for (const t of source) g[tripGroup(t.status)].push(t);
    // The dispatch queue is worked top-down: most-urgent pickup first, not
    // newest-created first (which buries the longest-waiting booking).
    g.pending.sort(byPickupUrgency);
    return g;
  }, [trips.data, needsAttentionOnly]);

  if (trips.isLoading) return <Loading />;
  if (trips.isError) return <ErrorState message="Could not load trips." onRetry={() => trips.refetch()} />;

  const all = trips.data ?? [];
  const selected = all.find((t) => t.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "calc(100vh - 150px)" }}>
      <Card pad={12} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <DispatchToggle />
      </Card>

      {/* ── Search + filters ── */}
      <Card pad={12} style={{ display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <SearchInput value={q} onChange={setQ} placeholder="Search ticket # or consignee…" />
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={controlStyle}>
            <option value="">All drivers</option>
            {(drivers.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={zone} onChange={(e) => setZone(e.target.value)} style={controlStyle}>
            <option value="">All zones</option>
            {ZONES.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: colors.textMuted }}>From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={controlStyle} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: colors.textMuted }}>To</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={controlStyle} />
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {/* Phase 2: one-click filter to the auto-dispatch failures. The chip
                always renders so the count is visible at a glance; it turns solid
                red when active. */}
            <button
              onClick={() => setNeedsAttentionOnly((v) => !v)}
              title="Show only bookings auto-dispatch could not place"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                borderRadius: radius.pill,
                padding: "5px 11px",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
                border: `1px solid ${colors.red}`,
                background: needsAttentionOnly ? colors.red : colors.redTint,
                color: needsAttentionOnly ? "#fff" : colors.red,
              }}
            >
              ⚠ Needs attention{attentionCount > 0 ? ` · ${attentionCount}` : ""}
            </button>
            <span style={{ fontSize: 12.5, color: colors.textMuted }}>
              {all.length} result{all.length === 1 ? "" : "s"}
            </span>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
            )}
          </div>
        </div>
        <SegmentedFilter options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, flex: 1, minHeight: 0 }}>
        {/* ── Left: grouped board ── */}
        <div style={{ overflowY: "auto", paddingRight: 4, display: "flex", flexDirection: "column", gap: 18 }}>
          {GROUP_ORDER.map((group) => {
            const list = grouped[group];
            if (list.length === 0) return null;
            return (
              <div key={group}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: GROUP_META[group].dot }} />
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: colors.textMuted }}>
                    {GROUP_META[group].label}
                  </span>
                  <span style={{ background: colors.panel, color: colors.textMuted, borderRadius: radius.pill, padding: "1px 8px", fontSize: 11.5, fontWeight: 700 }}>
                    {list.length}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {list.map((t) => (
                    <TripCard key={t.id} trip={t} selected={t.id === selectedId} onClick={() => setSelectedId(t.id)} />
                  ))}
                </div>
              </div>
            );
          })}
          {all.length === 0 && (
            <EmptyState message={hasFilters ? "No trips match these filters." : "No trips yet."} />
          )}
        </div>

        {/* ── Right: detail / dispatch ── */}
        <div style={{ overflowY: "auto" }}>
          {selected ? (
            <TripDetail key={selected.id} trip={selected} onDone={() => setSelectedId(null)} />
          ) : (
            <Card style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <EmptyState message="Select a trip to view details and dispatch." />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Trip card (left list) ─────────────────────────────────────────────
function TripCard({ trip, selected, onClick }: { trip: Trip; selected: boolean; onClick: () => void }) {
  const group = tripGroup(trip.status);
  // Auto-dispatch failed (still pending) → red accent + a distinct marker, so it
  // never looks like an ordinary "awaiting manual" pending card (Phase 2).
  const needsAttention = trip.status === "pending" && trip.auto_dispatch_failed;
  const accent = needsAttention
    ? colors.red
    : group === "pending" ? colors.orange : group === "active" ? colors.blue : group === "completed" ? colors.green : "#9ca3af";
  return (
    <div
      onClick={onClick}
      style={{
        background: colors.card,
        border: `1.5px solid ${selected ? accent : colors.border}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: radius.md,
        padding: 13,
        cursor: "pointer",
        boxShadow: selected ? "0 4px 14px rgba(0,0,0,0.08)" : undefined,
      }}
    >
      {needsAttention && (
        <div style={{ marginBottom: 7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: colors.red, fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>
            ⚠ Needs attention — auto-dispatch failed
          </div>
          {trip.auto_dispatch_note && (
            <div style={{ marginTop: 3, color: colors.red, fontSize: 12 }}>
              {trip.auto_dispatch_note}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.blue }}>{trip.ticket_number}</span>
        <TripStatusBadge status={trip.status} />
      </div>
      <div style={{ fontSize: 13, color: colors.text, marginBottom: 6 }}>
        {ORIGIN_LABEL} → <strong>{tripDestination(trip)}</strong>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11.5, color: colors.textMuted, flexShrink: 0 }}>{cargoSummary(trip)}</span>
        {/* Right-align the driver name with a touch of padding so it never sits
            flush against the card edge; ellipsis keeps long names from overflowing. */}
        <span
          style={{
            fontSize: 11.5,
            color: colors.textMuted,
            textAlign: "right",
            paddingRight: 2,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {trip.driver?.name ?? (trip.is_external ? "External" : "Unassigned")}
        </span>
      </div>
      {group === "active" && (
        <div style={{ marginTop: 9 }}>
          <ProgressBar pct={tripProgress(trip)} height={6} />
        </div>
      )}
    </div>
  );
}

// ── Trip detail / dispatch panel (right) ──────────────────────────────
function TripDetail({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  // Only GET /trips/:id carries the timeline; the list payload doesn't. Fetch
  // it on selection and fall back to the list trip for everything else.
  const detail = useTrip(trip.id);
  const timeline = detail.data?.timeline ?? [];
  return (
    <Card>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted }}>
            {trip.route_type.name}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: colors.text }}>{trip.ticket_number}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {trip.incentive_earned && (
            <Pill bg={colors.yellowTint} fg={colors.amber} border="#f0d98a">
              {formatMoney(trip.incentive_earned)}
            </Pill>
          )}
          <TripStatusBadge status={trip.status} />
        </div>
      </div>

      {/* Route banner */}
      <div
        style={{
          background: `linear-gradient(135deg, ${colors.blue}, #001a4d)`,
          borderRadius: radius.lg,
          padding: 18,
          color: "#fff",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", border: "3px solid #fff" }} />
          <div style={{ flex: 1, height: 2, background: "rgba(255,255,255,0.3)", position: "relative" }}>
            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${tripProgress(trip)}%`, background: colors.yellow }} />
          </div>
          <div style={{ width: 14, height: 14, borderRadius: "50%", background: colors.yellow }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12.5 }}>
          <span>{ORIGIN_LABEL}</span>
          <span style={{ fontWeight: 700 }}>{tripDestination(trip)}</span>
        </div>
        <div style={{ fontSize: 11.5, opacity: 0.8, marginTop: 6 }}>
          Pickup {formatDateTime(trip.pickup_datetime)}
        </div>
      </div>

      {/* Info row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 18 }}>
        <InfoTile label="Requestor" value={trip.requestor.name} sub={trip.requestor.phone} />
        <InfoTile label="Cargo" value={`${totalPallets(trip)} pallets`} sub={cargoSummary(trip)} />
        <InfoTile label="Consignee" value={tripConsigneeName(trip)} sub={`${trip.stops.length} stop${trip.stops.length === 1 ? "" : "s"}`} />
      </div>

      {/* Stops list */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 8 }}>
          Stops
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[...trip.stops].sort((a, b) => a.sequence - b.sequence).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "8px 10px", background: colors.panel, borderRadius: radius.sm }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", background: colors.blue, color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {s.sequence}
              </span>
              <span style={{ flex: 1 }}>{s.consignee.company_name}</span>
              {/* POD spot-check view (client Q2): pay is automatic once the
                  mandatory photo is in — admin just opens it to verify. */}
              {s.pod_photo && (
                <a
                  href={s.pod_photo}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 12, fontWeight: 700, color: colors.blue, textDecoration: "none", whiteSpace: "nowrap" }}
                >
                  📷 POD ↗
                </a>
              )}
              <span style={{ fontSize: 11, color: colors.textMuted }}>{s.consignee.zone_code}</span>
              <Pill
                bg={s.status === "delivered" ? colors.greenTint : s.status === "arrived" ? colors.blueTint : colors.panel}
                fg={s.status === "delivered" ? colors.green : s.status === "arrived" ? colors.blue : colors.textMuted}
              >
                {s.status}
              </Pill>
            </div>
          ))}
        </div>
      </div>

      {/* Adaptive status timeline (from GET /trips/:id) */}
      <StatusTimeline steps={timeline} />

      {/* Documents (DO / invoice uploaded by the requestor) */}
      <DocumentsSection trip={trip} />

      {/* Status-specific body */}
      {trip.status === "pending" && <DispatchPanel trip={trip} onDone={onDone} />}
      {(trip.status === "assigned" || trip.status === "in_progress" || trip.status === "approved") && (
        <MonitorPanel trip={trip} onDone={onDone} />
      )}
      {trip.status === "completed" && <CompletedPanel trip={trip} />}
      {(trip.status === "cancelled" || trip.status === "rejected") && (
        <div style={{ background: colors.panel, borderRadius: radius.md, padding: 14, fontSize: 13, color: colors.textMuted }}>
          <div>This booking was {trip.status}.</div>
          {trip.status === "rejected" && trip.rejection_reason && (
            <div style={{ marginTop: 8, color: colors.text }}>
              <strong style={{ color: colors.red }}>Reason:</strong> {trip.rejection_reason}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Documents (uploaded DO / invoice) ─────────────────────────────────
const DOC_TYPE_LABEL: Record<string, string> = {
  do_photo: "Delivery Order",
  k2_form: "K2 Customs Form",
  other: "Document",
};

function DocumentsSection({ trip }: { trip: Trip }) {
  const docs = trip.documents ?? [];
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 8 }}>
        Documents
      </div>
      {docs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: colors.textFaint, padding: "8px 10px", background: colors.panel, borderRadius: radius.sm }}>
          No documents uploaded.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {docs.map((d) => (
            <a
              key={d.id}
              href={d.file_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
                padding: "8px 10px",
                background: colors.panel,
                borderRadius: radius.sm,
                textDecoration: "none",
                color: colors.text,
              }}
            >
              <span style={{ fontSize: 16 }}>📄</span>
              <span style={{ flex: 1, fontWeight: 600 }}>{DOC_TYPE_LABEL[d.type] ?? "Document"}</span>
              <span style={{ fontSize: 11, color: colors.textMuted }}>{formatDateTime(d.uploaded_at)}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: colors.blue }}>View ↗</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function InfoTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: colors.panel, borderRadius: radius.md, padding: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textFaint }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Driver picker grid — shared by dispatch (pending) and the reassign
// lever (assigned). Availability/leave/fit logic identical in both flows.
function DriverGrid({
  trip,
  busy,
  onPick,
  currentDriverId,
}: {
  trip: Trip;
  busy: boolean;
  onPick: (driverId: string, plate: string, name: string) => void;
  // Reassign flow: the trip's current driver — shown but not pickable.
  currentDriverId?: string;
}) {
  const drivers = useDrivers();
  const pallets = totalPallets(trip);

  if (drivers.isLoading) return <Loading label="Loading drivers…" />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {(drivers.data ?? []).map((d) => {
        // Leave is checked against THIS trip's pickup MYT date (not
        // "today") — a driver on leave next week is still assignable
        // for tomorrow. Server enforces the same rule (DRIVER_ON_LEAVE).
        const pickupKey = mytDateKey(trip.pickup_datetime);
        const onLeave = d.leaves.some(
          (l) => l.start_date <= pickupKey && l.end_date >= pickupKey
        );
        const isCurrent = currentDriverId !== undefined && d.id === currentDriverId;
        const available = d.status === "available" && d.assigned_truck && !onLeave && !isCurrent;
        const remaining = d.assigned_truck ? d.assigned_truck.max_pallets - d.current_load : 0;
        const fits = d.assigned_truck ? remaining >= pallets : false;
        return (
          <div
            key={d.id}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: radius.md,
              padding: 12,
              opacity: available ? 1 : 0.55,
              background: available && fits ? colors.greenTint : colors.card,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
              <Avatar name={d.name} size={32} />
              <div style={{ overflow: "hidden" }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{d.name}</div>
                <div style={{ fontSize: 11, color: colors.textMuted }}>
                  {d.assigned_truck
                    ? `${d.assigned_truck.plate} · ${d.current_load}/${d.assigned_truck.max_pallets}p`
                    : "No truck"}
                  {/* Scheduled (assigned-but-not-started) trips: the driver
                      is still selectable, but assigning within the conflict
                      window will prompt an "Assign anyway" override. */}
                  {d.scheduled_trips > 0 ? ` · ${d.scheduled_trips} scheduled` : ""}
                </div>
              </div>
            </div>
            {available ? (
              <Button
                variant={fits ? "accent" : "ghost"}
                size="sm"
                full
                disabled={!fits || busy}
                onClick={() => onPick(d.id, d.assigned_truck!.plate, d.name)}
              >
                {fits ? "Assign" : d.current_load > 0 ? "No room" : "Too small"}
              </Button>
            ) : (
              <div style={{ fontSize: 11.5, color: colors.textMuted, textAlign: "center", padding: "7px 0" }}>
                {isCurrent
                  ? "Current driver"
                  : onLeave
                    ? "On leave for this pickup date"
                    : d.status === "on_trip"
                      ? `On route${d.current_route ? `: ${d.current_route}` : ""}`
                      : "Off duty"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Dispatch (pending) ────────────────────────────────────────────────
function DispatchPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Pending scheduling conflict awaiting the admin's "Assign anyway" decision.
  const [conflict, setConflict] = useState<
    { driverId: string; plate: string; conflicts: SchedulingConflictInfo[] } | null
  >(null);
  // Operating-window warning (Phase 3) awaiting the admin's "Assign anyway".
  const [windowWarn, setWindowWarn] = useState<
    { driverId: string; plate: string; message: string } | null
  >(null);
  // Expired-permit warning (roadworthiness gate) awaiting "Assign anyway".
  // Expired insurance/road tax is a hard TRUCK_UNROADWORTHY error — no override.
  const [permitWarn, setPermitWarn] = useState<
    { driverId: string; plate: string; message: string } | null
  >(null);

  const approve = useApproveTrip();
  const reject = useRejectTrip();
  const pallets = totalPallets(trip);

  async function assign(driverId: string, plate: string, force = false) {
    setError(null);
    try {
      await approve.mutateAsync({ id: trip.id, driver_id: driverId, truck_plate: plate, force });
      setConflict(null);
      setWindowWarn(null);
      setPermitWarn(null);
      onDone();
    } catch (e) {
      // The scheduling conflict, operating-window cutoff and expired permit are
      // recoverable soft warnings: surface them and let the admin re-submit with
      // force ("Assign anyway"). Other errors (overload, unroadworthy) are shown
      // plainly and cannot be overridden.
      const code = apiErrorCode(e);
      if (code === "SCHEDULING_CONFLICT") {
        setConflict({ driverId, plate, conflicts: apiErrorConflicts(e) });
        return;
      }
      if (code === "OPERATING_WINDOW") {
        setWindowWarn({ driverId, plate, message: apiErrorMessage(e, "Past the operating window.") });
        return;
      }
      if (code === "TRUCK_PERMIT_EXPIRED") {
        setPermitWarn({ driverId, plate, message: apiErrorMessage(e, "This truck's permit has expired.") });
        return;
      }
      setError(apiErrorMessage(e, "Could not assign driver."));
    }
  }

  async function doReject() {
    setError(null);
    try {
      await reject.mutateAsync({ id: trip.id, reason: reason.trim() || undefined });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not reject trip."));
    }
  }

  return (
    <div>
      {/* tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {([["internal", "🚛 Assign Internal Driver"], ["external", "🏢 External Forwarder"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: radius.md,
              border: `1px solid ${tab === v ? colors.blue : colors.border}`,
              background: tab === v ? colors.blueTint : colors.card,
              color: tab === v ? colors.blue : colors.textMuted,
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {conflict && (
        <div style={{ background: colors.yellowTint, border: "1px solid #f0d98a", borderRadius: radius.md, padding: "11px 13px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: colors.amber, marginBottom: 6 }}>
            ⚠ Scheduling conflict
          </div>
          {conflict.conflicts.map((c) => (
            <div key={c.tripId} style={{ fontSize: 12.5, color: colors.text, marginBottom: 3 }}>
              {c.plateOrDriverName} has another trip at <strong>{formatDateTime(c.pickup)}</strong>, within the conflict window of this pickup.
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              size="sm"
              disabled={approve.isPending}
              onClick={() => assign(conflict.driverId, conflict.plate, true)}
            >
              Assign anyway
            </Button>
          </div>
        </div>
      )}

      {windowWarn && (
        <div style={{ background: colors.yellowTint, border: "1px solid #f0d98a", borderRadius: radius.md, padding: "11px 13px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: colors.amber, marginBottom: 6 }}>
            ⚠ Operating window
          </div>
          <div style={{ fontSize: 12.5, color: colors.text, marginBottom: 3 }}>{windowWarn.message}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setWindowWarn(null)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              size="sm"
              disabled={approve.isPending}
              onClick={() => assign(windowWarn.driverId, windowWarn.plate, true)}
            >
              Assign anyway
            </Button>
          </div>
        </div>
      )}

      {permitWarn && (
        <div style={{ background: colors.yellowTint, border: "1px solid #f0d98a", borderRadius: radius.md, padding: "11px 13px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: colors.amber, marginBottom: 6 }}>
            ⚠ Permit expired
          </div>
          <div style={{ fontSize: 12.5, color: colors.text, marginBottom: 3 }}>
            {permitWarn.message} Overriding is audit-logged; update the date on the Trucks page once renewed.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setPermitWarn(null)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              size="sm"
              disabled={approve.isPending}
              onClick={() => assign(permitWarn.driverId, permitWarn.plate, true)}
            >
              Assign anyway
            </Button>
          </div>
        </div>
      )}

      {tab === "internal" ? (
        <div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10 }}>
            Showing available drivers (capacity ≥ {pallets} pallets highlighted as a fit).
          </div>
          <DriverGrid trip={trip} busy={approve.isPending} onPick={(driverId, plate) => assign(driverId, plate)} />
        </div>
      ) : (
        <ExternalForm trip={trip} onDone={onDone} />
      )}

      {/* Reject */}
      <div style={{ marginTop: 16, borderTop: `1px solid ${colors.divider}`, paddingTop: 14 }}>
        {!rejecting ? (
          <Button variant="outline" size="sm" onClick={() => setRejecting(true)}>
            Reject Request
          </Button>
        ) : (
          <div style={{ border: `1px solid ${colors.red}`, borderRadius: radius.md, padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Reason for rejection (optional)</div>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              style={{ width: "100%", padding: 10, borderRadius: radius.sm, border: `1px solid ${colors.border}`, fontSize: 13, outline: "none", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={reject.isPending} onClick={doReject}>Confirm Reject</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ExternalForm({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const [company, setCompany] = useState("");
  const [date, setDate] = useState(trip.pickup_datetime.slice(0, 10));
  const [rate, setRate] = useState("");
  const [cargo, setCargo] = useState(`${totalPallets(trip)} pallets`);
  const [error, setError] = useState<string | null>(null);
  // Outsourcing commits the booking to a third party — confirm before firing.
  const [confirming, setConfirming] = useState(false);
  const assign = useAssignExternal();

  async function submit() {
    setError(null);
    try {
      await assign.mutateAsync({
        id: trip.id,
        company_name: company.trim(),
        booking_date: new Date(date).toISOString(),
        rate: Number(rate) || 0,
        cargo_size: cargo.trim(),
      });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not assign forwarder."));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div>
      {error && (
        <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>
      )}
      <Input label="Forwarder Company" value={company} onChange={setCompany} placeholder="e.g. Penang Logistics Sdn Bhd" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Input label="Booking Date" value={date} onChange={setDate} type="date" />
        <Input label="Rate (RM)" value={rate} onChange={setRate} type="number" placeholder="0.00" />
      </div>
      <Input label="Cargo Size" value={cargo} onChange={setCargo} />
      <Button variant="accent" full disabled={!company.trim() || assign.isPending} onClick={() => setConfirming(true)}>
        {assign.isPending ? "Assigning…" : "Confirm External Assignment"}
      </Button>
      {confirming && (
        <ConfirmDialog
          title="Assign to external forwarder?"
          body={
            <>
              Outsource booking <strong>{trip.ticket_number}</strong> to{" "}
              <strong>{company.trim()}</strong>
              {rate ? <> at RM {rate}</> : null}? The booking leaves the internal fleet and
              no driver incentive applies.
            </>
          }
          confirmLabel="Assign Forwarder"
          pending={assign.isPending}
          onClose={() => setConfirming(false)}
          onConfirm={submit}
        />
      )}
    </div>
  );
}

// ── Monitor (active) ──────────────────────────────────────────────────
function MonitorPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const cancel = useCancelTrip();
  const unassign = useUnassignTrip();
  const [error, setError] = useState<string | null>(null);
  // Cancelling kills the booking outright — confirm before firing.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // Assigned-only ops lever (client Q3): unassign / change driver.
  const [confirmingUnassign, setConfirmingUnassign] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const canCancel = trip.status === "pending" || trip.status === "approved";
  // Only a not-yet-started trip can be interrupted; once the driver starts
  // (in_progress) this lever disappears (cancel-in-progress is out of scope).
  const canReassign = trip.status === "assigned" && !trip.is_external;

  async function doCancel() {
    setError(null);
    try {
      await cancel.mutateAsync(trip.id);
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not cancel trip."));
    } finally {
      setConfirmingCancel(false);
    }
  }

  async function doUnassign() {
    setError(null);
    try {
      await unassign.mutateAsync({ id: trip.id });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not unassign this trip."));
    } finally {
      setConfirmingUnassign(false);
    }
  }

  return (
    <div>
      <div style={{ background: colors.panel, borderRadius: radius.md, padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Delivery Progress</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.blue }}>{tripProgress(trip)}%</span>
        </div>
        <ProgressBar pct={tripProgress(trip)} height={10} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, border: `1px solid ${colors.border}`, borderRadius: radius.md }}>
        <Avatar name={trip.driver?.name ?? (trip.is_external ? "EX" : "?")} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{trip.driver?.name ?? "External forwarder"}</div>
          <div style={{ fontSize: 12, color: colors.textMuted }}>
            {trip.truck_plate ?? "—"}
            {trip.driver?.phone ? ` · ${trip.driver.phone}` : ""}
          </div>
        </div>
        {canReassign && (
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="outline" size="sm" disabled={unassign.isPending} onClick={() => setReassigning(true)}>
              Change driver
            </Button>
            <Button variant="ghost" size="sm" disabled={unassign.isPending} onClick={() => setConfirmingUnassign(true)}>
              Unassign
            </Button>
          </div>
        )}
      </div>

      {error && <div style={{ color: colors.red, fontSize: 12.5, marginTop: 12 }}>{error}</div>}

      {canCancel && (
        <div style={{ marginTop: 14 }}>
          <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => setConfirmingCancel(true)}>
            Cancel Booking
          </Button>
        </div>
      )}
      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this booking?"
          body={
            <>
              Cancel booking <strong>{trip.ticket_number}</strong>? The requestor keeps the
              record, but the trip will not be dispatched. This cannot be undone.
            </>
          }
          confirmLabel="Cancel Booking"
          pending={cancel.isPending}
          onClose={() => setConfirmingCancel(false)}
          onConfirm={doCancel}
        />
      )}
      {confirmingUnassign && (
        <ConfirmDialog
          title="Unassign this trip?"
          body={
            <>
              Remove <strong>{trip.driver?.name ?? "the driver"}</strong> from trip{" "}
              <strong>{trip.ticket_number}</strong>? The trip returns to Pending and re-enters
              the dispatch flow (auto-dispatch may pick it up again). The driver will be notified.
            </>
          }
          confirmLabel="Unassign"
          pending={unassign.isPending}
          onClose={() => setConfirmingUnassign(false)}
          onConfirm={doUnassign}
        />
      )}
      {reassigning && (
        <ReassignDialog trip={trip} onClose={() => setReassigning(false)} onDone={onDone} />
      )}
    </div>
  );
}

// ── Reassign (assigned → another driver+truck, client Q3 ops lever) ──────
// Server runs the FULL assignment guard ladder; the soft warnings (conflict /
// operating window / expired permit) come back as 409s the admin may override
// with "Assign anyway" — same UX as the dispatch panel. Hard blocks
// (overload, unroadworthy, busy, on leave) are shown plainly.
function ReassignDialog({ trip, onClose, onDone }: { trip: Trip; onClose: () => void; onDone: () => void }) {
  const reassign = useReassignTrip();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ driverId: string; plate: string; name: string } | null>(null);
  const [warn, setWarn] = useState<{ driverId: string; plate: string; name: string; message: string } | null>(null);

  async function submit(driverId: string, plate: string, name: string, force = false) {
    setError(null);
    try {
      await reassign.mutateAsync({ id: trip.id, driver_id: driverId, truck_plate: plate, force });
      onClose();
      onDone();
    } catch (e) {
      const code = apiErrorCode(e);
      if (code === "SCHEDULING_CONFLICT" || code === "OPERATING_WINDOW" || code === "TRUCK_PERMIT_EXPIRED") {
        setWarn({ driverId, plate, name, message: apiErrorMessage(e, "This assignment needs an override.") });
        return;
      }
      setError(apiErrorMessage(e, "Could not reassign this trip."));
    } finally {
      setPicked(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Change driver — ${trip.ticket_number}`} width={640}>
      <div style={{ fontSize: 12.5, color: colors.textMuted, marginBottom: 12 }}>
        Currently assigned to <strong>{trip.driver?.name ?? "—"}</strong>
        {trip.truck_plate ? ` · ${trip.truck_plate}` : ""}. Pick the new driver — the same
        dispatch checks apply, the incentive rates are re-snapshotted for the new truck, and
        both drivers are notified.
      </div>
      {error && (
        <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {warn && (
        <div style={{ background: colors.yellowTint, border: "1px solid #f0d98a", borderRadius: radius.md, padding: "11px 13px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: colors.amber, marginBottom: 6 }}>⚠ Needs override</div>
          <div style={{ fontSize: 12.5, color: colors.text, marginBottom: 3 }}>{warn.message}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button variant="ghost" size="sm" onClick={() => setWarn(null)}>Cancel</Button>
            <Button
              variant="accent"
              size="sm"
              disabled={reassign.isPending}
              onClick={() => submit(warn.driverId, warn.plate, warn.name, true)}
            >
              Assign anyway
            </Button>
          </div>
        </div>
      )}
      <DriverGrid
        trip={trip}
        busy={reassign.isPending}
        currentDriverId={trip.driver?.id}
        onPick={(driverId, plate, name) => setPicked({ driverId, plate, name })}
      />
      {picked && (
        <ConfirmDialog
          title="Move this trip?"
          body={
            <>
              Move trip <strong>{trip.ticket_number}</strong> from{" "}
              <strong>{trip.driver?.name ?? "—"}</strong> to <strong>{picked.name}</strong> (
              {picked.plate})? {trip.driver?.name ?? "The old driver"} will be notified the trip
              was removed.
            </>
          }
          confirmLabel="Change driver"
          pending={reassign.isPending}
          onClose={() => setPicked(null)}
          onConfirm={() => submit(picked.driverId, picked.plate, picked.name)}
        />
      )}
    </Modal>
  );
}

// ── Completed ─────────────────────────────────────────────────────────
function CompletedPanel({ trip }: { trip: Trip }) {
  return (
    <div>
      <div style={{ background: colors.greenTint, borderRadius: radius.md, padding: 14, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 28, height: 28, borderRadius: "50%", background: colors.green, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>✓</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: colors.green }}>Trip Completed</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <InfoTile label="Driver" value={trip.driver?.name ?? "—"} />
        <InfoTile label="Truck" value={trip.truck_plate ?? "—"} />
        <InfoTile label="Incentive" value={formatMoney(trip.incentive_earned)} />
      </div>
    </div>
  );
}
