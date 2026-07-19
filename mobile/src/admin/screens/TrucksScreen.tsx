// Truck Management — RN port of admin/src/pages/TrucksPage.tsx (PC-first:
// wide mirrors the old web admin at 1440px; narrow is functional single-
// column until the mobile pass). Fleet/Fuel tabs, FR-MT1 document-expiry
// alerts, the truck card grid (load visualiser, stats, claim-rate pills,
// document rows) and the renewal modal that un-blocks a truck for dispatch.
import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import {
  useCreateTruck,
  useRetireTruck,
  useTrucks,
  useTruckAlerts,
  useUpdateTruck,
  useUpdateTruckDocuments,
} from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Avatar, Button, Card, ChipGrid, ConfirmDialog, EmptyState, ErrorState, Input, Loading, Modal, Pill, SearchInput, SegmentedFilter } from "../components/ui";
import { LoadCapacityBar } from "../components/LoadCapacityBar";
import { FuelPanel } from "../components/FuelPanel";
import { DateField } from "../platform/datePicker";
import { useToast } from "../../components/Toast";
import { apiErrorMessage } from "../services/api";
import { formatDate, formatMoney, formatTime, mytDateKey } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DocExpiry, ExpiryStatus, Truck, TruckAlert, TruckExpiryAlert, TruckLoading } from "../types";

const STATUS_META: Record<string, { labelKey: string; bg: string; fg: string; dot: string }> = {
  active: { labelKey: "admin.trucks.statusActive", bg: colors.greenTint, fg: "#2E7D32", dot: colors.green },
  idle: { labelKey: "admin.trucks.statusIdle", bg: colors.blueTint, fg: colors.blue, dot: "#2563EB" },
  maintenance: { labelKey: "admin.trucks.statusMaintenance", bg: colors.orangeTint, fg: "#B45309", dot: colors.orange },
  retired: { labelKey: "admin.trucks.statusRetired", bg: "#f3f4f6", fg: "#4B5563", dot: "#9CA3AF" },
};

type Filter = "all" | "active" | "idle" | "maintenance" | "retired";
type Tab = "fleet" | "fuel";

/** Shift a "YYYY-MM-DD" MYT key by whole days, staying in MYT. */
function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return mytDateKey(new Date(Date.UTC(y, m - 1, d + days, 12))); // noon: never trips a boundary
}

export function TrucksScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  // Which MYT day's capacity is on screen (item 7b). Opens on TODAY — same
  // default as the Trips board, per Mr. Teh 16 Jul: "always show today date
  // everyday we sign in".
  const [date, setDate] = useState(() => mytDateKey(new Date()));
  const trucks = useTrucks(date);
  const [tab, setTab] = useState<Tab>("fleet");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Truck | null>(null);

  const counts = useMemo(() => {
    const list = trucks.data ?? [];
    return {
      all: list.length,
      active: list.filter((tr) => tr.status === "active").length,
      idle: list.filter((tr) => tr.status === "idle").length,
      maintenance: list.filter((tr) => tr.status === "maintenance").length,
      retired: list.filter((tr) => tr.status === "retired").length,
    };
  }, [trucks.data]);

  const wide = mode === "wide";
  const list = trucks.data ?? [];
  const filtered = list
    .filter((tr) => filter === "all" || tr.status === filter)
    .filter((tr) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return tr.plate.toLowerCase().includes(q) || (tr.driver?.name ?? "").toLowerCase().includes(q);
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={trucks.isRefetching} onRefresh={() => trucks.refetch()} />}
    >
      {/* Fleet / Fuel tabs, with "+ Add Truck" on the same line (right) so the
          fleet content sits directly below — no empty band. */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <SegmentedFilter<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "fleet", label: t("admin.trucks.tabFleet") },
            { value: "fuel", label: t("admin.trucks.tabFuel") },
          ]}
        />
        {tab === "fleet" && !trucks.isLoading && !trucks.isError && (
          <Button variant="primary" size="sm" onPress={() => setAdding(true)}>
            {`+ ${t("admin.trucks.addTruck")}`}
          </Button>
        )}
      </View>

      {tab === "fuel" ? (
        <FuelPanel />
      ) : trucks.isLoading ? (
        <Loading />
      ) : trucks.isError ? (
        <ErrorState message={t("admin.trucks.loadError")} onRetry={() => trucks.refetch()} />
      ) : (
        <>
          <AlertsPanel />

          {/* Narrow: an even 2-col chip grid; wide keeps the inline segmented row. */}
          {(() => {
            const filterOptions = [
              { value: "all" as Filter, label: t("admin.trucks.filterAll"), count: counts.all },
              { value: "active" as Filter, label: t("admin.trucks.statusActive"), count: counts.active },
              { value: "idle" as Filter, label: t("admin.trucks.statusIdle"), count: counts.idle },
              { value: "retired" as Filter, label: t("admin.trucks.statusRetired"), count: counts.retired },
            ];
            return wide ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <SegmentedFilter<Filter> value={filter} onChange={setFilter} options={filterOptions} />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <CapacityDatePicker date={date} onChange={setDate} wide />
                  <SearchInput value={search} onChange={setSearch} placeholder={t("admin.trucks.searchPlaceholder")} />
                </View>
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                <ChipGrid<Filter> value={filter} onChange={setFilter} options={filterOptions} columns={2} />
                <CapacityDatePicker date={date} onChange={setDate} />
                <SearchInput value={search} onChange={setSearch} placeholder={t("admin.trucks.searchPlaceholder")} style={{ minWidth: 0, alignSelf: "stretch" }} />
              </View>
            );
          })()}

          {filtered.length === 0 ? (
            <Card>
              <EmptyState message={t("admin.trucks.noMatch")} />
            </Card>
          ) : (
            <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 16 }}>
              {filtered.map((tr) => (
                <View key={tr.plate} style={wide ? { width: "48.9%", flexGrow: 1 } : undefined}>
                  <TruckCard truck={tr} onManage={() => setManaging(tr)} />
                </View>
              ))}
            </View>
          )}

          {adding ? <AddTruckModal onClose={() => setAdding(false)} /> : null}
          {managing ? <ManageTruckModal truck={managing} onClose={() => setManaging(null)} /> : null}
        </>
      )}
    </ScrollView>
  );
}

/**
 * Which day's capacity the fleet cards describe (item 7b: "let admin to select
 * to show the cargo capacity based on different date").
 *
 * The ‹ › steppers matter more than the text field here: the actual job is
 * "which day has room for this load", which means walking forward a day at a
 * time, not typing dates. Today is one tap back from anywhere.
 */
function CapacityDatePicker({
  date,
  onChange,
  wide = false,
}: {
  date: string;
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const today = mytDateKey(new Date());
  const isToday = date === today;

  return (
    <View style={{ gap: 6, alignSelf: wide ? "auto" : "stretch" }}>
      <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: "600" }}>
        {t("admin.trucks.capacityDate")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Button
          variant="outline"
          onPress={() => onChange(shiftDateKey(date, -1))}
        >
          <Ionicons name="chevron-back" size={16} color={colors.text} />
        </Button>
        {/* Fixed width on wide keeps the row from reflowing as the date changes;
            narrow lets it fill so the field stays tappable. */}
        <View style={wide ? { width: 150 } : { flex: 1 }}>
          <DateField value={date} onChange={onChange} />
        </View>
        <Button
          variant="outline"
          onPress={() => onChange(shiftDateKey(date, 1))}
        >
          <Ionicons name="chevron-forward" size={16} color={colors.text} />
        </Button>
        {!isToday ? (
          <Button variant="outline" onPress={() => onChange(today)}>
            {t("admin.trucks.capacityToday")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

/**
 * What the truck is carrying on the selected day — item 7b's core ask: "show
 * the current loading is assigned from which ticket, destination company name
 * and cargo details" + "should show the date of assigment cargo as well".
 *
 * Rendered as stacked rows inside the truck card in BOTH layouts, never a
 * table: the card is already half-width on wide, so a table here would be the
 * horizontal-scroll-on-a-phone failure the standing ruling exists to prevent.
 * Each row is one ticket.
 */
function CurrentLoading({ loading }: { loading: TruckLoading[] }) {
  const { t } = useTranslation();

  if (loading.length === 0) {
    return (
      <Text style={{ fontSize: font.xs, color: colors.textMuted, fontStyle: "italic" }}>
        {t("admin.trucks.loadingNone")}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      {loading.map((l) => (
        <View
          key={l.trip_id}
          style={{
            borderLeftWidth: 3,
            borderLeftColor: l.status === "in_progress" ? colors.green : colors.blue,
            paddingLeft: 8,
            gap: 2,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ fontSize: font.xs, fontWeight: "700", color: colors.text }} numberOfLines={1}>
              {l.ticket_number}
            </Text>
            <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
              {t("admin.trucks.palletsCount", { count: l.pallets })}
            </Text>
          </View>
          {/* Destination company — the ask. A multi-drop run names its final
              consignee and counts the rest, as the Trips board words it. */}
          <Text style={{ fontSize: font.xs, color: colors.text }} numberOfLines={1}>
            {l.destination ?? l.destination_area ?? "—"}
            {l.stop_count > 1 ? ` +${l.stop_count - 1}` : ""}
          </Text>
          <Text style={{ fontSize: font.xs, color: colors.textMuted }} numberOfLines={2}>
            {formatCargo(l.cargo, t)}
          </Text>
          {/* The assignment's own pickup date+time. */}
          <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
            {formatDate(l.pickup_datetime)} · {formatTime(l.pickup_datetime)}
          </Text>
        </View>
      ))}
    </View>
  );
}

type TFn = ReturnType<typeof useTranslation>["t"];

/** "4×4 × 15, Carton × 3" — pallet sizes read verbatim, carton/custom named. */
function formatCargo(cargo: TruckLoading["cargo"], t: TFn): string {
  if (cargo.length === 0) return "—";
  return cargo
    .map((c) => {
      if (c.pallet_type === "carton") return t("cargo.carton", { qty: c.quantity });
      if (c.pallet_type === "custom") return t("cargo.custom");
      return t("cargo.pallet", { size: c.pallet_type, qty: c.quantity });
    })
    .join(", ");
}

// ── FR-MT1: maintenance & document-expiry alerts panel ──────────────────
function expiryColors(status: ExpiryStatus): { fg: string; bg: string } {
  return status === "expired" ? { fg: colors.red, bg: colors.redTint } : { fg: colors.amber, bg: colors.orangeTint };
}

function AlertsPanel() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const alerts = useTruckAlerts();
  const list = alerts.data ?? [];
  if (list.length === 0) return null;

  return (
    <Card pad={0} style={{ overflow: "hidden", borderLeftWidth: 5, borderLeftColor: colors.orange }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: colors.orangeTint, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Ionicons name="warning-outline" size={20} color={colors.orange} />
        <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{t("admin.trucks.docAlertsTitle")}</Text>
        <Text style={{ marginLeft: "auto", fontSize: font.sm, color: colors.textMuted }}>
          {t("admin.trucks.needAttention", { count: list.length })}
        </Text>
      </View>
      <View style={{ flexDirection: mode === "wide" ? "row" : "column", flexWrap: "wrap", gap: 12, padding: 16 }}>
        {list.map((truck) => (
          <View key={truck.plate} style={mode === "wide" ? { minWidth: 280, flex: 1 } : undefined}>
            <AlertCard truck={truck} />
          </View>
        ))}
      </View>
    </Card>
  );
}

function AlertCard({ truck }: { truck: TruckExpiryAlert }) {
  const { t } = useTranslation();
  const docs = (["insurance", "permit", "road_tax"] as const)
    .map((key) => ({ key, label: t(`admin.dashboard.doc_${key}`), ...truck[key] }))
    .filter((d) => d.status !== "ok");

  const worst: ExpiryStatus = docs.some((d) => d.status === "expired") ? "expired" : "expiring_soon";
  const accent = expiryColors(worst).fg;

  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4, borderLeftColor: accent, borderRadius: radius.md, padding: 12 }}>
      <View style={{ marginBottom: 10 }}>
        <Text style={{ fontSize: 15, fontWeight: "800", letterSpacing: 0.3, color: colors.text }}>{truck.plate}</Text>
        <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{truck.type}</Text>
      </View>
      <View style={{ gap: 8 }}>
        {docs.map((d) => (
          <AlertDocRow key={d.key} label={d.label} doc={d} />
        ))}
      </View>
    </View>
  );
}

function AlertDocRow({ label, doc }: { label: string; doc: DocExpiry }) {
  const { t } = useTranslation();
  const { fg, bg } = expiryColors(doc.status);
  const days = doc.days_until_expiry ?? 0;
  const rel =
    days < 0
      ? t("admin.dashboard.expiredAgo", { count: Math.abs(days) })
      : days === 0
        ? t("admin.dashboard.expiresToday")
        : t("admin.dashboard.expiresIn", { count: days });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: fg }} />
        <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>{label}</Text>
        <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{formatDate(doc.expiry_date)}</Text>
      </View>
      <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 8 }}>
        <Text style={{ color: fg, fontSize: font.xs, fontWeight: "800" }}>{rel}</Text>
      </View>
    </View>
  );
}

function TruckCard({ truck: tr, onManage }: { truck: Truck; onManage: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const retire = useRetireTruck();
  const meta = STATUS_META[tr.status] ?? STATUS_META.idle;
  const retired = !!tr.retired_at;
  // Retired trucks are out of service — don't flag their doc expiries.
  const hasAlert = !retired && tr.alerts.length > 0;
  // Expired insurance/road tax hard-blocks dispatch (permit warns) — this
  // modal is the renewal path that un-bricks the truck.
  const [editingDocs, setEditingDocs] = useState(false);

  // One-tap reverse right on the card, in case a retire was a misclick — no
  // need to reopen Manage to un-retire.
  const reactivate = () =>
    retire.mutate(
      { plate: tr.plate, retired: false },
      {
        onSuccess: () => toast(t("admin.trucks.reactivatedNotice"), "success"),
        onError: (e) => toast(apiErrorMessage(e, t("admin.trucks.retireFailed")), "error"),
      }
    );

  return (
    <Card
      style={[
        { borderLeftWidth: 5, borderLeftColor: retired ? "#9CA3AF" : hasAlert ? colors.orange : meta.dot },
        hasAlert && { borderColor: "#FFB74D" },
        retired && { backgroundColor: "#fafafb", borderColor: "#e5e7eb" },
      ]}
    >
      {/* Unmistakable retired state: a grey "out of service" strip with a
          direct Reactivate, so a retire is both obvious and reversible. */}
      {retired && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: "#f3f4f6",
            borderWidth: 1,
            borderColor: "#e5e7eb",
            borderRadius: radius.md,
            paddingVertical: 8,
            paddingHorizontal: 12,
            marginBottom: 14,
          }}
        >
          <Ionicons name="ban-outline" size={16} color="#6b7280" />
          <Text style={{ flex: 1, fontSize: font.sm, fontWeight: "800", color: "#4b5563", letterSpacing: 0.4 }}>
            {t("admin.trucks.retiredCardNote")}
          </Text>
          <Button variant="success" size="sm" disabled={retire.isPending} onPress={reactivate}>
            {t("admin.trucks.reactivate")}
          </Button>
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Avatar size={46} glyph={<Ionicons name="bus" size={22} color={colors.yellow} />} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: font.lg, fontWeight: "800", letterSpacing: 0.3, color: colors.text }}>{tr.plate}</Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
            {tr.type} · {t("admin.trucks.palletsCount", { count: tr.max_pallets })}
          </Text>
        </View>
        <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot}>
          {t(meta.labelKey)}
        </Pill>
      </View>

      <View style={{ marginBottom: 14 }}>
        <LoadCapacityBar load={tr.current_load} capacity={tr.max_pallets} />
      </View>

      {/* What that bar is made of (item 7b). Directly under it on purpose: the
          bar is the number admin queries, this is the answer to "made up of
          what?" they previously had to open the Trips board to get. */}
      <View style={{ marginBottom: 14, gap: 6 }}>
        <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: "600" }}>
          {t("admin.trucks.loadingTitle")}
        </Text>
        <CurrentLoading loading={tr.current_loading} />
      </View>

      <View style={{ flexDirection: "row", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.divider, borderRadius: radius.md, overflow: "hidden", marginBottom: 12 }}>
        <Mini label={t("admin.trucks.statTripsToday")} value={String(tr.trips_today)} />
        <Mini label={t("admin.trucks.statDriver")} value={tr.driver?.name ?? t("admin.trucks.none")} divider wrap />
        <Mini label={t("admin.trucks.statZone")} value={tr.priority_zones[0] ?? "—"} divider />
      </View>

      {/* Claim rates — display only; edits live on the Incentives screen. */}
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <RatePill label={t("admin.trucks.rateWeekday")} value={formatMoney(tr.entitled_claim_weekday)} color={colors.blue} bg={colors.blueTint} />
        <RatePill label={t("admin.trucks.rateWeekend")} value={formatMoney(tr.entitled_claim_offpeak)} color={colors.amber} bg={colors.yellowTint} />
        <RatePill label={t("admin.trucks.rateDeduction")} value={t("admin.trucks.pts", { count: tr.daily_deduction_points })} color={colors.red} bg={colors.redTint} />
      </View>

      <View style={{ gap: 6 }}>
        <DocRow label={t("admin.dashboard.doc_insurance")} date={tr.insurance_expiry} alert={findAlert(tr.alerts, "insurance")} />
        <DocRow label={t("admin.dashboard.doc_permit")} date={tr.permit_expiry} alert={findAlert(tr.alerts, "permit")} />
        <DocRow label={t("admin.dashboard.doc_road_tax")} date={tr.road_tax_expiry} alert={findAlert(tr.alerts, "road_tax")} />
      </View>
      <View style={{ marginTop: 10, flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button variant="outline" size="sm" onPress={onManage}>
          {t("admin.trucks.manage")}
        </Button>
        <Button variant="ghost" size="sm" onPress={() => setEditingDocs(true)}>
          {t("admin.trucks.updateDocs")}
        </Button>
      </View>
      {editingDocs && <EditDocumentsModal truck={tr} onClose={() => setEditingDocs(false)} />}
    </Card>
  );
}

// Record renewed insurance / permit / road-tax expiry dates — the
// operational lever that puts a renewed truck back in the dispatch pool
// (audit-logged server-side).
function EditDocumentsModal({ truck, onClose }: { truck: Truck; onClose: () => void }) {
  const { t } = useTranslation();
  const toInput = (d: string | null) => (d ? d.slice(0, 10) : "");
  const [insurance, setInsurance] = useState(toInput(truck.insurance_expiry));
  const [permit, setPermit] = useState(toInput(truck.permit_expiry));
  const [roadTax, setRoadTax] = useState(toInput(truck.road_tax_expiry));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateTruckDocuments();

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        plate: truck.plate,
        insurance_expiry: insurance || null,
        permit_expiry: permit || null,
        road_tax_expiry: roadTax || null,
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.trucks.docsSaveFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.trucks.docsTitle", { plate: truck.plate })} width={400}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <DateField label={t("admin.trucks.insuranceExpiry")} value={insurance} onChange={setInsurance} />
      <DateField label={t("admin.trucks.permitExpiry")} value={permit} onChange={setPermit} />
      <DateField label={t("admin.trucks.roadTaxExpiry")} value={roadTax} onChange={setRoadTax} />
      <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
        <Button variant="ghost" onPress={onClose} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={update.isPending} onPress={save} style={{ flex: 1 }}>
          {update.isPending ? t("admin.trucks.saving") : t("admin.trucks.saveDates")}
        </Button>
      </View>
    </Modal>
  );
}

function findAlert(alerts: TruckAlert[], doc: TruckAlert["doc"]) {
  return alerts.find((a) => a.doc === doc);
}

function DocRow({ label, date, alert }: { label: string; date: string | null; alert?: TruckAlert }) {
  const { t } = useTranslation();
  const flagged = !!alert;
  const color = !flagged ? colors.text : alert!.daysLeft < 0 ? colors.red : colors.orange;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {flagged && <Ionicons name="warning-outline" size={13} color={color} />}
        <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{label}</Text>
      </View>
      <Text style={{ fontSize: font.sm, color, fontWeight: flagged ? "700" : "500" }}>
        {formatDate(date)}
        {flagged && (alert!.daysLeft < 0 ? ` · ${t("admin.trucks.expired")}` : ` · ${alert!.daysLeft}d`)}
      </Text>
    </View>
  );
}

function Mini({ label, value, divider, wrap }: { label: string; value: string; divider?: boolean; wrap?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: 0, paddingVertical: 9, paddingHorizontal: 10, borderLeftWidth: divider ? 1 : 0, borderLeftColor: colors.divider, alignItems: "center" }}>
      <Text numberOfLines={wrap ? 3 : 1} style={{ fontSize: font.md, fontWeight: "700", color: colors.text, textAlign: "center" }}>
        {value}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: 12, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>
        {label}
      </Text>
    </View>
  );
}

function RatePill({ label, value, color, bg }: { label: string; value: string; color: string; bg: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 10, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 12, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "700", color, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}

// ── Fleet CRUD: add / manage a truck ─────────────────────────────────────
const TRUCK_SECTION = { fontSize: font.md, fontWeight: "800" as const, color: colors.text, marginTop: 18, marginBottom: 10 };

function TruckBanner({ text, kind }: { text: string; kind: "error" | "success" }) {
  const c = kind === "error" ? colors.red : colors.green;
  return (
    <View style={{ backgroundColor: `${c}14`, borderRadius: radius.md, padding: 11, marginBottom: 12 }}>
      <Text style={{ color: c, fontSize: font.sm, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

const parseNum = (s: string): number => {
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : NaN;
};
const splitZones = (s: string): string[] => s.split(",").map((z) => z.trim()).filter(Boolean);

function AddTruckModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateTruck();
  const [plate, setPlate] = useState("");
  const [type, setType] = useState("");
  const [maxPallets, setMaxPallets] = useState("");
  const [weekday, setWeekday] = useState("");
  const [offpeak, setOffpeak] = useState("");
  const [deduction, setDeduction] = useState("");
  const [zones, setZones] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const mp = parseNum(maxPallets);
    const wd = parseNum(weekday);
    const op = parseNum(offpeak);
    const dd = parseNum(deduction);
    if (!plate.trim() || !type.trim() || !(mp > 0) || !(wd > 0) || !(op > 0) || !(dd >= 0)) {
      setError(t("admin.trucks.createValidation"));
      return;
    }
    try {
      await create.mutateAsync({
        plate: plate.trim(),
        type: type.trim(),
        max_pallets: Math.round(mp),
        entitled_claim_weekday: wd,
        entitled_claim_offpeak: op,
        daily_deduction_points: Math.round(dd),
        ...(splitZones(zones).length ? { priority_zones: splitZones(zones) } : {}),
        ...(start.trim() ? { operating_hours_start: start.trim() } : {}),
        ...(end.trim() ? { operating_hours_end: end.trim() } : {}),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.trucks.createFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.trucks.addTruckTitle")} width={480}>
      {error ? <TruckBanner text={error} kind="error" /> : null}
      <Input label={t("admin.trucks.fieldPlate")} value={plate} onChange={setPlate} placeholder="ABC 1234" />
      <Input label={t("admin.trucks.fieldType")} value={type} onChange={setType} placeholder="10t-30ft" />
      <Input label={t("admin.trucks.fieldMaxPallets")} value={maxPallets} onChange={setMaxPallets} type="number" />
      <Input label={t("admin.trucks.fieldWeekday")} value={weekday} onChange={setWeekday} type="number" />
      <Input label={t("admin.trucks.fieldOffpeak")} value={offpeak} onChange={setOffpeak} type="number" />
      <Input label={t("admin.trucks.fieldDeduction")} value={deduction} onChange={setDeduction} type="number" />
      <Input label={t("admin.trucks.fieldZones")} value={zones} onChange={setZones} placeholder={t("admin.trucks.zonesHint")} />
      <Input label={t("admin.trucks.fieldHoursStart")} value={start} onChange={setStart} placeholder="07:00" />
      <Input label={t("admin.trucks.fieldHoursEnd")} value={end} onChange={setEnd} placeholder="18:00" />
      <Text style={{ fontSize: font.sm, color: colors.textFaint, marginBottom: 12 }}>{t("admin.trucks.ratesNote")}</Text>
      <Button variant="primary" full disabled={create.isPending} onPress={submit}>
        {create.isPending ? t("admin.trucks.creating") : t("admin.trucks.create")}
      </Button>
    </Modal>
  );
}

function ManageTruckModal({ truck, onClose }: { truck: Truck; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateTruck();
  const retire = useRetireTruck();
  const [type, setType] = useState(truck.type);
  const [maxPallets, setMaxPallets] = useState(String(truck.max_pallets));
  const [zones, setZones] = useState(truck.priority_zones.join(", "));
  const [start, setStart] = useState(truck.operating_hours_start);
  const [end, setEnd] = useState(truck.operating_hours_end);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const retired = !!truck.retired_at;
  const clear = () => {
    setError(null);
    setNotice(null);
  };

  async function saveAttrs() {
    clear();
    const mp = parseNum(maxPallets);
    if (!type.trim() || !(mp > 0)) {
      setError(t("admin.trucks.createValidation"));
      return;
    }
    try {
      await update.mutateAsync({
        plate: truck.plate,
        type: type.trim(),
        max_pallets: Math.round(mp),
        priority_zones: splitZones(zones),
        ...(start.trim() ? { operating_hours_start: start.trim() } : {}),
        ...(end.trim() ? { operating_hours_end: end.trim() } : {}),
      });
      setNotice(t("admin.trucks.attributesSaved"));
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.trucks.updateFailed")));
    }
  }
  function toggleRetire(next: boolean) {
    clear();
    retire.mutate(
      { plate: truck.plate, retired: next },
      {
        // Success feedback is a toast (visible regardless of modal scroll — the
        // old inline banner rendered at the top of a long modal, above the
        // Retire button, so it read as "nothing happened") + close the modal so
        // the admin lands back on the list where the card now shows Retired.
        onSuccess: () => {
          setConfirmRetire(false);
          toast(next ? t("admin.trucks.retiredNotice") : t("admin.trucks.reactivatedNotice"), "success");
          onClose();
        },
        onError: (e) => {
          setConfirmRetire(false);
          toast(apiErrorMessage(e, t("admin.trucks.retireFailed")), "error");
        },
      }
    );
  }

  return (
    <Modal open onClose={onClose} title={t("admin.trucks.manageTitle", { plate: truck.plate })} width={480}>
      {error ? <TruckBanner text={error} kind="error" /> : null}
      {notice ? <TruckBanner text={notice} kind="success" /> : null}

      <Text style={TRUCK_SECTION}>{t("admin.trucks.sectionAttributes")}</Text>
      <Input label={t("admin.trucks.fieldType")} value={type} onChange={setType} />
      <Input label={t("admin.trucks.fieldMaxPallets")} value={maxPallets} onChange={setMaxPallets} type="number" />
      <Input label={t("admin.trucks.fieldZones")} value={zones} onChange={setZones} placeholder={t("admin.trucks.zonesHint")} />
      <Input label={t("admin.trucks.fieldHoursStart")} value={start} onChange={setStart} />
      <Input label={t("admin.trucks.fieldHoursEnd")} value={end} onChange={setEnd} />
      <Text style={{ fontSize: font.sm, color: colors.textFaint, marginBottom: 12 }}>{t("admin.trucks.ratesNote")}</Text>
      <Button variant="primary" size="sm" disabled={update.isPending} onPress={saveAttrs}>
        {t("admin.trucks.saveAttributes")}
      </Button>

      <Text style={TRUCK_SECTION}>{t("admin.trucks.sectionRetire")}</Text>
      {retired ? (
        <Button variant="success" size="sm" disabled={retire.isPending} onPress={() => toggleRetire(false)}>
          {t("admin.trucks.reactivate")}
        </Button>
      ) : (
        <Button variant="danger" size="sm" disabled={retire.isPending} onPress={() => setConfirmRetire(true)}>
          {t("admin.trucks.retire")}
        </Button>
      )}

      {confirmRetire ? (
        <ConfirmDialog
          title={t("admin.trucks.retireTitle")}
          body={t("admin.trucks.retireBody", { plate: truck.plate })}
          confirmLabel={t("admin.trucks.retire")}
          pending={retire.isPending}
          onClose={() => setConfirmRetire(false)}
          onConfirm={() => toggleRetire(true)}
        />
      ) : null}
    </Modal>
  );
}
