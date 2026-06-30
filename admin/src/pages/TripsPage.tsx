import { useEffect, useMemo, useState } from "react";
import {
  useApproveTrip,
  useAssignExternal,
  useCancelTrip,
  useDrivers,
  useRejectTrip,
  useTrip,
  useTrips,
} from "@/hooks/queries";
import { colors, radius } from "@/theme";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Pill,
  ProgressBar,
  SearchInput,
  SegmentedFilter,
  TripStatusBadge,
} from "@/components/ui";
import { DispatchToggle } from "@/components/DispatchToggle";
import { StatusTimeline } from "@/components/StatusTimeline";
import { apiErrorMessage } from "@/services/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import {
  ORIGIN_LABEL,
  cargoSummary,
  totalPallets,
  tripConsigneeName,
  tripDestination,
  tripGroup,
  tripProgress,
} from "@/lib/trip";
import type { Trip } from "@/types";

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

  const hasFilters = !!(q || status || driverId || zone || dateFrom || dateTo);
  const clearFilters = () => {
    setQ("");
    setDebouncedQ("");
    setStatus("");
    setDriverId("");
    setZone("");
    setDateFrom("");
    setDateTo("");
  };

  const grouped = useMemo(() => {
    const g: Record<string, Trip[]> = { pending: [], active: [], completed: [], cancelled: [] };
    for (const t of trips.data ?? []) g[tripGroup(t.status)].push(t);
    return g;
  }, [trips.data]);

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
  const accent =
    group === "pending" ? colors.orange : group === "active" ? colors.blue : group === "completed" ? colors.green : "#9ca3af";
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

// ── Dispatch (pending) ────────────────────────────────────────────────
function DispatchPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const drivers = useDrivers();
  const approve = useApproveTrip();
  const reject = useRejectTrip();
  const pallets = totalPallets(trip);

  async function assign(driverId: string, plate: string) {
    setError(null);
    try {
      await approve.mutateAsync({ id: trip.id, driver_id: driverId, truck_plate: plate });
      onDone();
    } catch (e) {
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

      {tab === "internal" ? (
        <div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10 }}>
            Showing available drivers (capacity ≥ {pallets} pallets highlighted as a fit).
          </div>
          {drivers.isLoading ? (
            <Loading label="Loading drivers…" />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(drivers.data ?? []).map((d) => {
                const available = d.status === "available" && d.assigned_truck;
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
                        </div>
                      </div>
                    </div>
                    {available ? (
                      <Button
                        variant={fits ? "accent" : "ghost"}
                        size="sm"
                        full
                        disabled={!fits || approve.isPending}
                        onClick={() => assign(d.id, d.assigned_truck!.plate)}
                      >
                        {fits ? "Assign" : d.current_load > 0 ? "No room" : "Too small"}
                      </Button>
                    ) : (
                      <div style={{ fontSize: 11.5, color: colors.textMuted, textAlign: "center", padding: "7px 0" }}>
                        {d.status === "on_trip" ? `On route${d.current_route ? `: ${d.current_route}` : ""}` : "Off duty"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
      <Button variant="accent" full disabled={!company.trim() || assign.isPending} onClick={submit}>
        {assign.isPending ? "Assigning…" : "Confirm External Assignment"}
      </Button>
    </div>
  );
}

// ── Monitor (active) ──────────────────────────────────────────────────
function MonitorPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const cancel = useCancelTrip();
  const [error, setError] = useState<string | null>(null);
  const canCancel = trip.status === "pending" || trip.status === "approved";

  async function doCancel() {
    setError(null);
    try {
      await cancel.mutateAsync(trip.id);
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not cancel trip."));
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
      </div>

      {error && <div style={{ color: colors.red, fontSize: 12.5, marginTop: 12 }}>{error}</div>}

      {canCancel && (
        <div style={{ marginTop: 14 }}>
          <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={doCancel}>
            Cancel Booking
          </Button>
        </div>
      )}
    </div>
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
