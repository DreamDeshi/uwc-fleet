// Truck Management — RN port of admin/src/pages/TrucksPage.tsx (PC-first:
// wide mirrors the old web admin at 1440px; narrow is functional single-
// column until the mobile pass). Fleet/Fuel tabs, FR-MT1 document-expiry
// alerts, the truck card grid (load visualiser, stats, claim-rate pills,
// document rows) and the renewal modal that un-blocks a truck for dispatch.
import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useTrucks, useTruckAlerts, useUpdateTruckDocuments } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Avatar, Button, Card, EmptyState, ErrorState, Loading, Modal, Pill, SearchInput, SegmentedFilter } from "../components/ui";
import { LoadCapacityBar } from "../components/LoadCapacityBar";
import { FuelPanel } from "../components/FuelPanel";
import { DateField } from "../platform/datePicker";
import { apiErrorMessage } from "../services/api";
import { formatDate, formatMoney } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DocExpiry, ExpiryStatus, Truck, TruckAlert, TruckExpiryAlert } from "../types";

const STATUS_META: Record<string, { labelKey: string; bg: string; fg: string; dot: string }> = {
  active: { labelKey: "admin.trucks.statusActive", bg: colors.greenTint, fg: "#2E7D32", dot: colors.green },
  idle: { labelKey: "admin.trucks.statusIdle", bg: colors.blueTint, fg: colors.blue, dot: "#2563EB" },
  maintenance: { labelKey: "admin.trucks.statusMaintenance", bg: colors.orangeTint, fg: "#B45309", dot: colors.orange },
};

type Filter = "all" | "active" | "idle" | "maintenance";
type Tab = "fleet" | "fuel";

export function TrucksScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const trucks = useTrucks();
  const [tab, setTab] = useState<Tab>("fleet");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    const list = trucks.data ?? [];
    return {
      all: list.length,
      active: list.filter((tr) => tr.status === "active").length,
      idle: list.filter((tr) => tr.status === "idle").length,
      maintenance: list.filter((tr) => tr.status === "maintenance").length,
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
      <SegmentedFilter<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "fleet", label: t("admin.trucks.tabFleet") },
          { value: "fuel", label: t("admin.trucks.tabFuel") },
        ]}
      />

      {tab === "fuel" ? (
        <FuelPanel />
      ) : trucks.isLoading ? (
        <Loading />
      ) : trucks.isError ? (
        <ErrorState message={t("admin.trucks.loadError")} onRetry={() => trucks.refetch()} />
      ) : (
        <>
          <AlertsPanel />

          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <SegmentedFilter<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("admin.trucks.filterAll"), count: counts.all },
                { value: "active", label: t("admin.trucks.statusActive"), count: counts.active },
                { value: "idle", label: t("admin.trucks.statusIdle"), count: counts.idle },
                { value: "maintenance", label: t("admin.trucks.statusMaintenance"), count: counts.maintenance },
              ]}
            />
            <SearchInput value={search} onChange={setSearch} placeholder={t("admin.trucks.searchPlaceholder")} style={!wide && { minWidth: 0, alignSelf: "stretch" }} />
          </View>

          {filtered.length === 0 ? (
            <Card>
              <EmptyState message={t("admin.trucks.noMatch")} />
            </Card>
          ) : (
            <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 16 }}>
              {filtered.map((tr) => (
                <View key={tr.plate} style={wide ? { width: "48.9%", flexGrow: 1 } : undefined}>
                  <TruckCard truck={tr} />
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
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

function TruckCard({ truck: tr }: { truck: Truck }) {
  const { t } = useTranslation();
  const meta = STATUS_META[tr.status] ?? STATUS_META.idle;
  const hasAlert = tr.alerts.length > 0;
  // Expired insurance/road tax hard-blocks dispatch (permit warns) — this
  // modal is the renewal path that un-bricks the truck.
  const [editingDocs, setEditingDocs] = useState(false);
  return (
    <Card
      style={[
        { borderLeftWidth: 5, borderLeftColor: hasAlert ? colors.orange : meta.dot },
        hasAlert && { borderColor: "#FFB74D" },
      ]}
    >
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
      <View style={{ marginTop: 10 }}>
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
      <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>
        {label}
      </Text>
    </View>
  );
}

function RatePill({ label, value, color, bg }: { label: string; value: string; color: string; bg: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 10, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 11, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "700", color, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}
