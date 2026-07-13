// Trip Management — RN port of admin/src/pages/TripsPage.tsx (Phase 4 final,
// PC-first). THE MONEY/OPERATIONS SCREEN: every mutation rides the verbatim
// ported hooks (approve/reject/unassign/reassign/assign-external/cancel) —
// dispatch and rate-snapshot logic is API-side and NOT re-implemented here.
// The 409 handling mirrors the old admin exactly:
//   SCHEDULING_CONFLICT  → conflict list + audited "Assign anyway" (force)
//   OPERATING_WINDOW     → window warning + audited "Assign anyway" (force)
//   TRUCK_PERMIT_EXPIRED → permit warning + audited "Assign anyway" (force)
//   everything else (overload, unroadworthy, DRIVER_ON_LEAVE, raced
//   CONCURRENT_ASSIGNMENT / TRIP_STATE_CHANGED) → plain error, no override.
import React, { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import {
  useApproveTrip,
  useAssignExternal,
  useCancelTrip,
  useDrivers,
  useRejectTrip,
  useReassignTrip,
  useTrip,
  useTripBoard,
  useUnassignTrip,
} from "../hooks/queries";
import { colors, font, radius } from "../theme";
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
} from "../components/ui";
import { DispatchToggle } from "../components/DispatchToggle";
import { StatusTimeline } from "../components/StatusTimeline";
import { DateField } from "../platform/datePicker";
import { apiErrorMessage, apiErrorCode, apiErrorConflicts } from "../services/api";
import { formatDateTime, formatMoney, formatTime, mytDateKey } from "../lib/format";
import { ZONES as ZONE_INFOS } from "../lib/zones";
import { byPickupUrgency } from "../lib/pendingOrder";
import { flattenTripPages, tripsTotal } from "../lib/tripPages";
import {
  ORIGIN_LABEL,
  cargoSummary,
  totalPallets,
  tripConsigneeName,
  tripDestination,
  tripGroup,
  tripProgress,
} from "../lib/trip";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { Trip, SchedulingConflictInfo } from "../types";

const GROUP_ORDER = ["pending", "active", "completed", "cancelled"] as const;
const GROUP_META: Record<string, { labelKey: string; dot: string; tint: string; fg: string }> = {
  pending: { labelKey: "admin.trips.groupPending", dot: colors.orange, tint: colors.orangeTint, fg: "#B45309" },
  active: { labelKey: "admin.trips.groupActive", dot: colors.blue, tint: colors.blueTint, fg: colors.blue },
  completed: { labelKey: "admin.trips.groupCompleted", dot: colors.green, tint: colors.greenTint, fg: "#2E7D32" },
  cancelled: { labelKey: "admin.trips.groupCancelled", dot: "#9ca3af", tint: "#F3F4F6", fg: "#4B5563" },
};

const ZONES = ZONE_INFOS.map((z) => z.code);

export function TripsScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Filters. Free-text debounced 300ms; the rest apply immediately.
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");
  const [driverId, setDriverId] = useState("");
  const [zone, setZone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const [driverPickerOpen, setDriverPickerOpen] = useState(false);
  const [zonePickerOpen, setZonePickerOpen] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const trips = useTripBoard({
    q: debouncedQ,
    status,
    driver_id: driverId,
    zone,
    date_from: dateFrom,
    date_to: dateTo,
  });
  const drivers = useDrivers();

  const all = useMemo(() => flattenTripPages(trips.data?.pages), [trips.data]);
  const total = tripsTotal(trips.data?.pages, all.length);

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

  const needsAttention = (tr: Trip) => tr.status === "pending" && tr.auto_dispatch_failed;
  const attentionCount = useMemo(() => all.filter(needsAttention).length, [all]);

  const grouped = useMemo(() => {
    const g: Record<string, Trip[]> = { pending: [], active: [], completed: [], cancelled: [] };
    const source = needsAttentionOnly ? all.filter(needsAttention) : all;
    for (const tr of source) g[tripGroup(tr.status)].push(tr);
    g.pending.sort(byPickupUrgency);
    return g;
  }, [all, needsAttentionOnly]);

  if (trips.isLoading) return <Loading />;
  if (trips.isError) return <ErrorState message={t("admin.trips.loadError")} onRetry={() => trips.refetch()} />;

  const wide = mode === "wide";
  const boardCount = GROUP_ORDER.reduce((sum, g) => sum + grouped[g].length, 0);
  const selected = all.find((tr) => tr.id === selectedId) ?? null;
  const olderCount = total - all.length;
  const selectedDriver = (drivers.data ?? []).find((d) => d.id === driverId);

  const board = (
    <View style={{ gap: 18 }}>
      {GROUP_ORDER.map((group) => {
        const list = grouped[group];
        if (list.length === 0) return null;
        return (
          <View key={group}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: GROUP_META[group].dot }} />
              <Text style={{ fontSize: font.sm, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", color: colors.text }}>
                {t(GROUP_META[group].labelKey)}
              </Text>
              <View style={{ backgroundColor: GROUP_META[group].tint, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 9 }}>
                <Text style={{ color: GROUP_META[group].fg, fontSize: font.xs, fontWeight: "800" }}>{list.length}</Text>
              </View>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.divider }} />
            </View>
            <View style={{ gap: 10 }}>
              {list.map((tr) => (
                <TripCard key={tr.id} trip={tr} selected={tr.id === selectedId} onPress={() => setSelectedId(tr.id)} />
              ))}
            </View>
          </View>
        );
      })}
      {all.length === 0 ? (
        <EmptyState message={hasFilters ? t("admin.trips.noMatch") : t("admin.trips.noTrips")} />
      ) : boardCount === 0 ? (
        <EmptyState message={needsAttentionOnly ? t("admin.trips.noAttention") : t("admin.trips.noMatch")} />
      ) : null}
      {trips.hasNextPage && (
        <View style={{ paddingBottom: 8 }}>
          <Button variant="outline" size="sm" full disabled={trips.isFetchingNextPage} onPress={() => trips.fetchNextPage()}>
            {trips.isFetchingNextPage
              ? t("admin.trips.loadingOlder")
              : olderCount > 0
                ? t("admin.trips.loadOlderCount", { count: olderCount })
                : t("admin.trips.loadOlder")}
          </Button>
        </View>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1, paddingVertical: wide ? 24 : 14, paddingHorizontal: wide ? 28 : 14, gap: 16 }}>
        <Card pad={12} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <DispatchToggle />
        </Card>

        {/* ── Search + filters ── */}
        <Card pad={12} style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <SearchInput value={q} onChange={setQ} placeholder={t("admin.trips.searchPlaceholder")} style={!wide && { minWidth: 0, alignSelf: "stretch", flexBasis: "100%" }} />
            <FilterSelect
              label={selectedDriver ? selectedDriver.name : t("admin.trips.allDrivers")}
              onPress={() => setDriverPickerOpen(true)}
            />
            <FilterSelect label={zone || t("admin.trips.allZones")} onPress={() => setZonePickerOpen(true)} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.trips.from")}</Text>
              <DateInputInline value={dateFrom} onChange={setDateFrom} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.trips.to")}</Text>
              <DateInputInline value={dateTo} onChange={setDateTo} />
            </View>
            <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {/* One-click filter to the auto-dispatch failures. */}
              <Pressable
                onPress={() => setNeedsAttentionOnly(!needsAttentionOnly)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: radius.pill,
                  paddingVertical: 5,
                  paddingHorizontal: 11,
                  borderWidth: 1,
                  borderColor: colors.red,
                  backgroundColor: needsAttentionOnly ? colors.red : colors.redTint,
                }}
              >
                <Ionicons name="warning" size={12} color={needsAttentionOnly ? "#fff" : colors.red} />
                <Text style={{ fontSize: font.sm, fontWeight: "700", color: needsAttentionOnly ? "#fff" : colors.red }}>
                  {t("admin.trips.needsAttention")}
                  {attentionCount > 0 ? ` · ${attentionCount}` : ""}
                </Text>
              </Pressable>
              <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
                {olderCount > 0
                  ? t("admin.trips.resultsOf", { shown: all.length, total })
                  : t("admin.trips.results", { count: all.length })}
              </Text>
              {hasFilters && (
                <Button variant="ghost" size="sm" onPress={clearFilters}>
                  {t("admin.trips.clearFilters")}
                </Button>
              )}
            </View>
          </View>
          <SegmentedFilter
            options={[
              { value: "", label: t("admin.trips.statusAll") },
              { value: "pending", label: t("admin.status.pending") },
              { value: "assigned", label: t("admin.status.assigned") },
              { value: "in_progress", label: t("admin.status.in_progress") },
              { value: "completed", label: t("admin.status.completed") },
              { value: "cancelled", label: t("admin.status.cancelled") },
            ]}
            value={status}
            onChange={setStatus}
          />
        </Card>

        {/* ── Board + detail ── */}
        {wide ? (
          <View style={{ flexDirection: "row", gap: 16, flex: 1, minHeight: 0 }}>
            <ScrollView style={{ width: 360, flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ paddingRight: 4, paddingBottom: 12 }}>
              {board}
            </ScrollView>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
              {selected ? (
                <TripDetail key={selected.id} trip={selected} onDone={() => setSelectedId(null)} />
              ) : (
                <Card style={{ minHeight: 300, alignItems: "center", justifyContent: "center" }}>
                  <EmptyState message={t("admin.trips.selectPrompt")} />
                </Card>
              )}
            </ScrollView>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
            {board}
          </ScrollView>
        )}
      </View>

      {/* Narrow: full-screen detail layer (functional, pre-polish). */}
      {!wide && selected && (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.bg }}>
          <View style={{ backgroundColor: colors.blue, height: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 }}>
            <Pressable
              onPress={() => setSelectedId(null)}
              style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="chevron-back" size={18} color="#fff" />
            </Pressable>
            <Text style={{ color: "#fff", fontSize: font.lg, fontWeight: "800" }}>{selected.ticket_number}</Text>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 28 }}>
            <TripDetail key={selected.id} trip={selected} onDone={() => setSelectedId(null)} />
          </ScrollView>
        </View>
      )}

      <OptionsModal
        visible={driverPickerOpen}
        title={t("admin.trips.allDrivers")}
        options={[{ label: t("admin.trips.allDrivers"), value: "" }, ...(drivers.data ?? []).map((d) => ({ label: d.name, value: d.id }))]}
        selectedValue={driverId}
        onSelect={setDriverId}
        onClose={() => setDriverPickerOpen(false)}
      />
      <OptionsModal
        visible={zonePickerOpen}
        title={t("admin.trips.allZones")}
        options={[{ label: t("admin.trips.allZones"), value: "" }, ...ZONES.map((z) => ({ label: z, value: z }))]}
        selectedValue={zone}
        onSelect={setZone}
        onClose={() => setZonePickerOpen(false)}
      />
    </View>
  );
}

function FilterSelect({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.card,
      }}
    >
      <Text style={{ fontSize: font.md, color: colors.text }}>{label}</Text>
      <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
    </Pressable>
  );
}

// Compact inline YYYY-MM-DD filter input (the old admin's native date input;
// real picker arrives with the mobile pass).
function DateInputInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.textFaint}
      style={{
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        fontSize: font.md,
        color: colors.text,
        backgroundColor: colors.card,
        width: 130,
      }}
    />
  );
}

// ── Trip card (left list) ─────────────────────────────────────────────
function TripCard({ trip, selected, onPress }: { trip: Trip; selected: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const group = tripGroup(trip.status);
  const needsAttention = trip.status === "pending" && trip.auto_dispatch_failed;
  const accent = needsAttention
    ? colors.red
    : group === "pending" ? colors.orange : group === "active" ? colors.blue : group === "completed" ? colors.green : "#9ca3af";
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: colors.card,
        borderWidth: 1.5,
        borderColor: selected ? accent : colors.border,
        borderLeftWidth: 5,
        borderLeftColor: accent,
        borderRadius: radius.md,
        padding: 14,
      }}
    >
      {needsAttention && (
        <View style={{ marginBottom: 7 }}>
          <Text style={{ color: colors.red, fontSize: font.xs, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 }}>
            ⚠ {t("admin.trips.cardAttention")}
          </Text>
          {trip.auto_dispatch_note && <Text style={{ marginTop: 3, color: colors.red, fontSize: font.sm }}>{trip.auto_dispatch_note}</Text>}
        </View>
      )}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 7, gap: 8 }}>
        <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.blue, letterSpacing: 0.2 }}>{trip.ticket_number}</Text>
        <TripStatusBadge status={trip.status} />
      </View>
      <View style={{ marginBottom: 7 }}>
        <Text style={{ fontSize: 14.5, fontWeight: "700", color: colors.text, lineHeight: 18 }}>{tripDestination(trip)}</Text>
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
          {t("admin.trips.fromOrigin", { origin: ORIGIN_LABEL })}
        </Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.trips.palletsShort", { count: totalPallets(trip) })}</Text>
        <Text numberOfLines={1} style={{ fontSize: font.sm, color: colors.textMuted, flexShrink: 1 }}>
          {trip.driver?.name ?? ""}
        </Text>
      </View>
      {group === "active" && (
        <View style={{ marginTop: 9 }}>
          <ProgressBar pct={tripProgress(trip)} height={6} />
        </View>
      )}
    </Pressable>
  );
}

// ── Trip detail / dispatch panel ──────────────────────────────────────
function TripDetail({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const detail = useTrip(trip.id);
  const timeline = detail.data?.timeline ?? [];
  const wide = mode === "wide";
  return (
    <Card>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: font.xs, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted }}>
            {trip.route_type.name}
          </Text>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>{trip.ticket_number}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {trip.incentive_earned && (
            <Pill bg={colors.yellowTint} fg={colors.amber} border="#f0d98a">
              {formatMoney(trip.incentive_earned)}
            </Pill>
          )}
          <TripStatusBadge status={trip.status} />
        </View>
      </View>

      {/* Route banner */}
      <View style={{ backgroundColor: "#001a4d", borderRadius: radius.lg, padding: 18, marginBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: "#fff" }} />
          <View style={{ flex: 1, height: 2, backgroundColor: "rgba(255,255,255,0.3)" }}>
            <View style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${tripProgress(trip)}%`, backgroundColor: colors.yellow }} />
          </View>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: colors.yellow }} />
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
          <Text style={{ color: "#fff", fontSize: font.sm }}>{ORIGIN_LABEL}</Text>
          <Text style={{ color: "#fff", fontSize: font.sm, fontWeight: "700" }}>{tripDestination(trip)}</Text>
        </View>
        <Text style={{ fontSize: font.xs, color: "rgba(255,255,255,0.8)", marginTop: 6 }}>
          {t("admin.trips.pickupAt", { when: formatDateTime(trip.pickup_datetime) })}
        </Text>
      </View>

      {/* Info row */}
      <View style={{ flexDirection: wide ? "row" : "column", gap: 12, marginBottom: 18 }}>
        <InfoTile label={t("admin.trips.infoRequestor")} value={trip.requestor.name} sub={trip.requestor.phone} wide={wide} />
        <InfoTile label={t("admin.trips.infoCargo")} value={t("admin.trips.palletsShort", { count: totalPallets(trip) })} sub={cargoSummary(trip)} wide={wide} />
        <InfoTile label={t("admin.trips.infoConsignee")} value={tripConsigneeName(trip)} sub={t("admin.trips.stopsCount", { count: trip.stops.length })} wide={wide} />
      </View>

      {/* Stops list */}
      <View style={{ marginBottom: 18 }}>
        <Text style={{ fontSize: font.sm, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 8 }}>
          {t("admin.trips.stops")}
        </Text>
        <View style={{ gap: 6 }}>
          {[...trip.stops].sort((a, b) => a.sequence - b.sequence).map((s) => (
            <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.panel, borderRadius: radius.sm }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#fff", fontSize: font.xs, fontWeight: "700" }}>{s.sequence}</Text>
              </View>
              <Text numberOfLines={2} style={{ flex: 1, fontSize: font.md, color: colors.text }}>{s.consignee.company_name}</Text>
              {s.pod_photo && (
                <Pressable onPress={() => Linking.openURL(s.pod_photo!)}>
                  <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>📷 POD ↗</Text>
                </Pressable>
              )}
              <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{s.consignee.zone_code}</Text>
              <Pill
                bg={s.status === "delivered" ? colors.greenTint : s.status === "arrived" ? colors.blueTint : colors.panel}
                fg={s.status === "delivered" ? colors.green : s.status === "arrived" ? colors.blue : colors.textMuted}
              >
                {t(`admin.trips.stop_${s.status}`, { defaultValue: s.status })}
              </Pill>
            </View>
          ))}
        </View>
      </View>

      <StatusTimeline steps={timeline} />
      <DocumentsSection trip={trip} />

      {/* Status-specific body */}
      {trip.status === "pending" && <DispatchPanel trip={trip} onDone={onDone} />}
      {(trip.status === "assigned" || trip.status === "in_progress" || trip.status === "approved") && (
        <MonitorPanel trip={trip} onDone={onDone} />
      )}
      {trip.status === "completed" && <CompletedPanel trip={trip} />}
      {(trip.status === "cancelled" || trip.status === "rejected") && (
        <View style={{ backgroundColor: colors.panel, borderRadius: radius.md, padding: 14 }}>
          <Text style={{ fontSize: font.md, color: colors.textMuted }}>
            {t("admin.trips.wasStatus", { status: t(`admin.status.${trip.status}`, { defaultValue: trip.status }) })}
          </Text>
          {trip.status === "rejected" && trip.rejection_reason && (
            <Text style={{ marginTop: 8, fontSize: font.md, color: colors.text }}>
              <Text style={{ fontWeight: "700", color: colors.red }}>{t("admin.trips.reason")}:</Text> {trip.rejection_reason}
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}

// ── Documents (uploaded DO / invoice) ─────────────────────────────────
function DocumentsSection({ trip }: { trip: Trip }) {
  const { t } = useTranslation();
  const docs = trip.documents ?? [];
  return (
    <View style={{ marginBottom: 18 }}>
      <Text style={{ fontSize: font.sm, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 8 }}>
        {t("admin.trips.documents")}
      </Text>
      {docs.length === 0 ? (
        <Text style={{ fontSize: font.sm, color: colors.textFaint, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.panel, borderRadius: radius.sm }}>
          {t("admin.trips.noDocuments")}
        </Text>
      ) : (
        <View style={{ gap: 6 }}>
          {docs.map((d) => (
            <Pressable
              key={d.id}
              onPress={() => Linking.openURL(d.file_url)}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.panel, borderRadius: radius.sm }}
            >
              <Text style={{ fontSize: 16 }}>📄</Text>
              <Text style={{ flex: 1, fontWeight: "600", fontSize: font.md, color: colors.text }}>
                {t(`admin.trips.doc_${d.type}`, { defaultValue: t("admin.trips.doc_other") })}
              </Text>
              <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{formatDateTime(d.uploaded_at)}</Text>
              <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>{t("admin.trips.view")} ↗</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function InfoTile({ label, value, sub, wide }: { label: string; value: string; sub?: string; wide: boolean }) {
  return (
    <View style={{ flex: wide ? 1 : undefined, backgroundColor: colors.panel, borderRadius: radius.md, padding: 12 }}>
      <Text style={{ fontSize: font.xs, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, color: colors.textFaint }}>{label}</Text>
      <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text, marginTop: 4 }}>{value}</Text>
      {sub ? <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}

// Amber override box shared by the three soft 409 warnings — cancel or
// "Assign anyway" (re-submits with force=true; audited server-side).
function OverrideBox({
  title,
  children,
  busy,
  onCancel,
  onForce,
}: {
  title: string;
  children: React.ReactNode;
  busy: boolean;
  onCancel: () => void;
  onForce: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={{ backgroundColor: colors.yellowTint, borderWidth: 1, borderColor: "#f0d98a", borderRadius: radius.md, paddingVertical: 11, paddingHorizontal: 13, marginBottom: 12 }}>
      <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.amber, marginBottom: 6 }}>⚠ {title}</Text>
      {children}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
        <Button variant="ghost" size="sm" onPress={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="accent" size="sm" disabled={busy} onPress={onForce}>
          {t("admin.trips.assignAnyway")}
        </Button>
      </View>
    </View>
  );
}

// ── Driver picker grid — shared by dispatch (pending) and reassign ─────
function DriverGrid({
  trip,
  busy,
  onPick,
  currentDriverId,
}: {
  trip: Trip;
  busy: boolean;
  onPick: (driverId: string, plate: string, name: string) => void;
  currentDriverId?: string;
}) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const drivers = useDrivers();
  const pallets = totalPallets(trip);
  const wide = mode === "wide";

  if (drivers.isLoading) return <Loading label={t("admin.trips.loadingDrivers")} />;
  return (
    <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 10 }}>
      {(drivers.data ?? []).map((d) => {
        // Leave is checked against THIS trip's pickup MYT date (server
        // enforces the same rule, DRIVER_ON_LEAVE).
        const pickupKey = mytDateKey(trip.pickup_datetime);
        const onLeave = d.leaves.some((l) => l.start_date <= pickupKey && l.end_date >= pickupKey);
        const isCurrent = currentDriverId !== undefined && d.id === currentDriverId;
        const available = d.status === "available" && d.assigned_truck && !onLeave && !isCurrent;
        const remaining = d.assigned_truck ? d.assigned_truck.max_pallets - d.current_load : 0;
        const fits = d.assigned_truck ? remaining >= pallets : false;
        return (
          <View
            key={d.id}
            style={{
              width: wide ? "48.7%" : undefined,
              flexGrow: wide ? 1 : undefined,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              padding: 12,
              opacity: available ? 1 : 0.55,
              backgroundColor: available && fits ? colors.greenTint : colors.card,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }}>
              <Avatar name={d.name} size={32} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{d.name}</Text>
                <Text numberOfLines={1} style={{ fontSize: font.xs, color: colors.textMuted }}>
                  {d.assigned_truck
                    ? `${d.assigned_truck.plate} · ${d.current_load}/${d.assigned_truck.max_pallets}p`
                    : t("admin.trips.noTruck")}
                  {d.scheduled_trips > 0 ? ` · ${t("admin.trips.scheduledShort", { count: d.scheduled_trips })}` : ""}
                </Text>
              </View>
            </View>
            {available ? (
              <Button
                variant={fits ? "accent" : "ghost"}
                size="sm"
                full
                disabled={!fits || busy}
                onPress={() => onPick(d.id, d.assigned_truck!.plate, d.name)}
              >
                {fits ? t("admin.trips.assign") : d.current_load > 0 ? t("admin.trips.noRoom") : t("admin.trips.tooSmall")}
              </Button>
            ) : (
              <Text style={{ fontSize: font.xs, color: colors.textMuted, textAlign: "center", paddingVertical: 7 }}>
                {isCurrent
                  ? t("admin.trips.currentDriver")
                  : onLeave
                    ? t("admin.trips.onLeaveDate")
                    : d.status === "on_trip"
                      ? `${t("admin.trips.onRoute")}${d.current_route ? `: ${d.current_route}` : ""}`
                      : t("admin.drivers.statusOffDuty")}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Dispatch (pending) ────────────────────────────────────────────────
function DispatchPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"internal" | "external">("internal");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ driverId: string; plate: string; conflicts: SchedulingConflictInfo[] } | null>(null);
  const [windowWarn, setWindowWarn] = useState<{ driverId: string; plate: string; message: string } | null>(null);
  const [permitWarn, setPermitWarn] = useState<{ driverId: string; plate: string; message: string } | null>(null);

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
      // Conflict / window / permit are recoverable soft warnings ("Assign
      // anyway" resubmits with force). Everything else — overload,
      // unroadworthy, DRIVER_ON_LEAVE, raced assignment — shows plainly and
      // cannot be overridden. Identical to the old admin.
      const code = apiErrorCode(e);
      if (code === "SCHEDULING_CONFLICT") {
        setConflict({ driverId, plate, conflicts: apiErrorConflicts(e) });
        return;
      }
      if (code === "OPERATING_WINDOW") {
        setWindowWarn({ driverId, plate, message: apiErrorMessage(e, t("admin.trips.windowFallback")) });
        return;
      }
      if (code === "TRUCK_PERMIT_EXPIRED") {
        setPermitWarn({ driverId, plate, message: apiErrorMessage(e, t("admin.trips.permitFallback")) });
        return;
      }
      setError(apiErrorMessage(e, t("admin.trips.assignFailed")));
    }
  }

  async function doReject() {
    setError(null);
    try {
      await reject.mutateAsync({ id: trip.id, reason: reason.trim() || undefined });
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.trips.rejectFailed")));
    }
  }

  return (
    <View>
      {/* tabs */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
        {([["internal", t("admin.trips.tabInternal")], ["external", t("admin.trips.tabExternal")]] as const).map(([v, label]) => (
          <Pressable
            key={v}
            onPress={() => setTab(v)}
            style={{
              flex: 1,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: tab === v ? colors.blue : colors.border,
              backgroundColor: tab === v ? colors.blueTint : colors.card,
              alignItems: "center",
            }}
          >
            <Text style={{ color: tab === v ? colors.blue : colors.textMuted, fontWeight: "700", fontSize: font.md }}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}

      {conflict && (
        <OverrideBox
          title={t("admin.trips.conflictTitle")}
          busy={approve.isPending}
          onCancel={() => setConflict(null)}
          onForce={() => assign(conflict.driverId, conflict.plate, true)}
        >
          {conflict.conflicts.map((c) => (
            <Text key={c.tripId} style={{ fontSize: font.sm, color: colors.text, marginBottom: 3 }}>
              {t("admin.trips.conflictLine", { who: c.plateOrDriverName, when: formatDateTime(c.pickup) })}
            </Text>
          ))}
        </OverrideBox>
      )}

      {windowWarn && (
        <OverrideBox
          title={t("admin.trips.windowTitle")}
          busy={approve.isPending}
          onCancel={() => setWindowWarn(null)}
          onForce={() => assign(windowWarn.driverId, windowWarn.plate, true)}
        >
          <Text style={{ fontSize: font.sm, color: colors.text, marginBottom: 3 }}>{windowWarn.message}</Text>
        </OverrideBox>
      )}

      {permitWarn && (
        <OverrideBox
          title={t("admin.trips.permitTitle")}
          busy={approve.isPending}
          onCancel={() => setPermitWarn(null)}
          onForce={() => assign(permitWarn.driverId, permitWarn.plate, true)}
        >
          <Text style={{ fontSize: font.sm, color: colors.text, marginBottom: 3 }}>
            {permitWarn.message} {t("admin.trips.permitOverrideNote")}
          </Text>
        </OverrideBox>
      )}

      {tab === "internal" ? (
        <View>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginBottom: 10 }}>
            {t("admin.trips.showingDrivers", { count: pallets })}
          </Text>
          <DriverGrid trip={trip} busy={approve.isPending} onPick={(driverId, plate) => assign(driverId, plate)} />
        </View>
      ) : (
        <ExternalForm trip={trip} onDone={onDone} />
      )}

      {/* Reject */}
      <View style={{ marginTop: 16, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 14 }}>
        {!rejecting ? (
          <Button variant="outline" size="sm" onPress={() => setRejecting(true)}>
            {t("admin.trips.rejectRequest")}
          </Button>
        ) : (
          <View style={{ borderWidth: 1, borderColor: colors.red, borderRadius: radius.md, padding: 12 }}>
            <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 8, color: colors.text }}>
              {t("admin.trips.rejectReasonLabel")}
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={2}
              style={{
                padding: 10,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: colors.border,
                fontSize: font.md,
                color: colors.text,
                backgroundColor: colors.card,
                minHeight: 54,
                textAlignVertical: "top",
              }}
            />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <Button variant="ghost" size="sm" onPress={() => setRejecting(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" size="sm" disabled={reject.isPending} onPress={doReject}>
                {t("admin.trips.confirmReject")}
              </Button>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

function ExternalForm({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { t } = useTranslation();
  const [company, setCompany] = useState("");
  // MYT calendar day of the pickup (ISO slice would take the UTC day —
  // yesterday for early-morning MYT pickups; audit 2026-07-05 #8).
  const [date, setDate] = useState(mytDateKey(trip.pickup_datetime));
  const [rate, setRate] = useState("");
  const [cargo, setCargo] = useState(t("admin.trips.palletsShort", { count: totalPallets(trip) }));
  const [error, setError] = useState<string | null>(null);
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
      setError(apiErrorMessage(e, t("admin.trips.forwarderFailed")));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <View>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Input label={t("admin.trips.forwarderCompany")} value={company} onChange={setCompany} placeholder={t("admin.trips.forwarderPlaceholder")} />
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <DateField label={t("admin.trips.bookingDate")} value={date} onChange={setDate} />
        </View>
        <View style={{ flex: 1 }}>
          <Input label={t("admin.trips.rateRm")} value={rate} onChange={setRate} type="number" placeholder="0.00" />
        </View>
      </View>
      <Input label={t("admin.trips.cargoSize")} value={cargo} onChange={setCargo} />
      <Button variant="accent" full disabled={!company.trim() || assign.isPending} onPress={() => setConfirming(true)}>
        {assign.isPending ? t("admin.trips.assigning") : t("admin.trips.confirmExternal")}
      </Button>
      {confirming && (
        <ConfirmDialog
          title={t("admin.trips.externalTitle")}
          body={t("admin.trips.externalBody", {
            ticket: trip.ticket_number,
            company: company.trim(),
            rate: rate ? ` ${t("admin.trips.externalAtRate", { rate })}` : "",
          })}
          confirmLabel={t("admin.trips.assignForwarder")}
          pending={assign.isPending}
          onClose={() => setConfirming(false)}
          onConfirm={submit}
        />
      )}
    </View>
  );
}

// ── Monitor (active) ──────────────────────────────────────────────────
function MonitorPanel({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { t } = useTranslation();
  const cancel = useCancelTrip();
  const unassign = useUnassignTrip();
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [confirmingUnassign, setConfirmingUnassign] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const canCancel = trip.status === "pending" || trip.status === "approved";
  const canReassign = trip.status === "assigned" && !trip.is_external;

  async function doCancel() {
    setError(null);
    try {
      await cancel.mutateAsync(trip.id);
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.trips.cancelFailed")));
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
      setError(apiErrorMessage(e, t("admin.trips.unassignFailed")));
    } finally {
      setConfirmingUnassign(false);
    }
  }

  return (
    <View>
      <View style={{ backgroundColor: colors.panel, borderRadius: radius.md, padding: 14, marginBottom: 14 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
          <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{t("admin.trips.deliveryProgress")}</Text>
          <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.blue }}>{tripProgress(trip)}%</Text>
        </View>
        <ProgressBar pct={tripProgress(trip)} height={10} />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, flexWrap: "wrap" }}>
        <Avatar name={trip.driver?.name ?? (trip.is_external ? "EX" : "?")} />
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>
            {trip.driver?.name ?? t("admin.dashboard.external")}
          </Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
            {trip.truck_plate ?? "—"}
            {trip.driver?.phone ? ` · ${trip.driver.phone}` : ""}
          </Text>
        </View>
        {canReassign && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button variant="outline" size="sm" disabled={unassign.isPending} onPress={() => setReassigning(true)}>
              {t("admin.trips.changeDriver")}
            </Button>
            <Button variant="ghost" size="sm" disabled={unassign.isPending} onPress={() => setConfirmingUnassign(true)}>
              {t("admin.trips.unassign")}
            </Button>
          </View>
        )}
      </View>

      {error && <Text style={{ color: colors.red, fontSize: font.sm, marginTop: 12 }}>{error}</Text>}

      {canCancel && (
        <View style={{ marginTop: 14 }}>
          <Button variant="outline" size="sm" disabled={cancel.isPending} onPress={() => setConfirmingCancel(true)}>
            {t("admin.trips.cancelBooking")}
          </Button>
        </View>
      )}
      {confirmingCancel && (
        <ConfirmDialog
          title={t("admin.trips.cancelTitle")}
          body={t("admin.trips.cancelBody", { ticket: trip.ticket_number })}
          confirmLabel={t("admin.trips.cancelBooking")}
          pending={cancel.isPending}
          onClose={() => setConfirmingCancel(false)}
          onConfirm={doCancel}
        />
      )}
      {confirmingUnassign && (
        <ConfirmDialog
          title={t("admin.trips.unassignTitle")}
          body={t("admin.trips.unassignBody", { name: trip.driver?.name ?? "—", ticket: trip.ticket_number })}
          confirmLabel={t("admin.trips.unassign")}
          pending={unassign.isPending}
          onClose={() => setConfirmingUnassign(false)}
          onConfirm={doUnassign}
        />
      )}
      {reassigning && <ReassignDialog trip={trip} onClose={() => setReassigning(false)} onDone={onDone} />}
    </View>
  );
}

// ── Reassign (assigned → another driver+truck) ────────────────────────
function ReassignDialog({ trip, onClose, onDone }: { trip: Trip; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
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
        setWarn({ driverId, plate, name, message: apiErrorMessage(e, t("admin.trips.overrideFallback")) });
        return;
      }
      setError(apiErrorMessage(e, t("admin.trips.reassignFailed")));
    } finally {
      setPicked(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.trips.reassignTitle", { ticket: trip.ticket_number })} width={640}>
      <Text style={{ fontSize: font.sm, color: colors.textMuted, marginBottom: 12 }}>
        {t("admin.trips.reassignIntro", {
          name: trip.driver?.name ?? "—",
          plate: trip.truck_plate ? ` · ${trip.truck_plate}` : "",
        })}
      </Text>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      {warn && (
        <OverrideBox
          title={t("admin.trips.needsOverride")}
          busy={reassign.isPending}
          onCancel={() => setWarn(null)}
          onForce={() => submit(warn.driverId, warn.plate, warn.name, true)}
        >
          <Text style={{ fontSize: font.sm, color: colors.text, marginBottom: 3 }}>{warn.message}</Text>
        </OverrideBox>
      )}
      <DriverGrid
        trip={trip}
        busy={reassign.isPending}
        currentDriverId={trip.driver?.id}
        onPick={(driverId, plate, name) => setPicked({ driverId, plate, name })}
      />
      {picked && (
        <ConfirmDialog
          title={t("admin.trips.moveTitle")}
          body={t("admin.trips.moveBody", {
            ticket: trip.ticket_number,
            from: trip.driver?.name ?? "—",
            to: picked.name,
            plate: picked.plate,
          })}
          confirmLabel={t("admin.trips.changeDriver")}
          pending={reassign.isPending}
          onClose={() => setPicked(null)}
          onConfirm={() => submit(picked.driverId, picked.plate, picked.name)}
        />
      )}
    </Modal>
  );
}

// ── Completed — the pay-breakdown panel (finalize-time evidence) ───────
function CompletedPanel({ trip }: { trip: Trip }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const stops = [...trip.stops].sort((a, b) => a.sequence - b.sequence);
  const hasBreakdown = stops.some((s) => s.points_awarded !== null && s.points_awarded !== undefined);
  const wide = mode === "wide";
  return (
    <View>
      <View style={{ backgroundColor: colors.greenTint, borderRadius: radius.md, padding: 14, marginBottom: 14, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#fff", fontWeight: "800" }}>✓</Text>
        </View>
        <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.green }}>{t("admin.trips.tripCompleted")}</Text>
      </View>
      <View style={{ flexDirection: wide ? "row" : "column", gap: 12 }}>
        <InfoTile label={t("admin.trips.infoDriver")} value={trip.driver?.name ?? "—"} wide={wide} />
        <InfoTile label={t("admin.trucks.colTruck")} value={trip.truck_plate ?? "—"} wide={wide} />
        <InfoTile label={t("admin.trips.infoIncentive")} value={formatMoney(trip.incentive_earned)} wide={wide} />
      </View>

      {/* Pay breakdown — "why did this trip pay RM44?" answerable without
          re-running the rule by hand. Figures come straight from the stored
          finalize-time evidence. */}
      <View style={{ marginTop: 16 }}>
        <Text style={{ fontSize: font.sm, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, color: colors.textMuted, marginBottom: 8 }}>
          {t("admin.trips.payBreakdown")}
        </Text>
        {hasBreakdown ? (
          <View style={{ backgroundColor: colors.panel, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 12, gap: 5 }}>
            {stops.map((s) => (
              <View key={s.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                <Text style={{ flex: 1, fontSize: font.sm, color: colors.text }}>
                  {t("admin.trips.stop", { n: s.sequence })} · {s.zone_code ?? s.consignee.zone_code}
                  <Text style={{ color: colors.textMuted }}>
                    {s.was_repeat ? ` — ${t("admin.trips.repeatZone")}` : ` — ${t("admin.trips.firstInZone")}`}
                    {s.delivered_at ? ` · ${t("admin.trips.deliveredAt", { time: formatTime(s.delivered_at) })}` : ""}
                  </Text>
                </Text>
                <Text style={{ fontWeight: "700", fontSize: font.sm, color: colors.text }}>
                  {t("admin.trips.ptsAwarded", { count: s.points_awarded ?? 0 })}
                </Text>
              </View>
            ))}
            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, marginTop: 3, paddingTop: 7, flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
              <Text style={{ flex: 1, fontSize: font.sm, color: colors.textMuted }}>
                {trip.rate_used != null
                  ? t("admin.trips.rateUsed", {
                      rate: formatMoney(trip.rate_used),
                      tier: trip.off_peak ? t("admin.trips.tierOffPeak") : t("admin.trips.tierWeekday"),
                    })
                  : t("admin.trips.rateVaries")}
                {" · "}
                {t("admin.trips.deductionApplied", { count: trip.deduction_applied ?? 0 })}
              </Text>
              <Text style={{ fontWeight: "800", color: colors.text, fontSize: font.sm }}>{formatMoney(trip.incentive_earned)}</Text>
            </View>
          </View>
        ) : (
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.trips.noBreakdown")}</Text>
        )}
      </View>
    </View>
  );
}
