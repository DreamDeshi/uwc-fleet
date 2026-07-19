// The PC/wide dashboard — a faithful RN port of the web admin's
// DashboardPage layout (owner direction: on wide screens the admin matches
// the old web admin; the greeting home is mobile-only). Same hooks, same
// data, same order: dispatch-mode bar → attention panel → gradient KPI tiles
// → fleet map + alerts/load rail → recent-trips table → drivers footnote.
// The map area renders the Phase-3 placeholder until the real map lands.
import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import {
  useAttention,
  useDashboard,
  useDrivers,
  useFleetLive,
  useTrips,
  useTrucks,
} from "../hooks/queries";
import { colors, font, gradients, kpiShadow, radius } from "../theme";
import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  Loading,
  Pill,
  ProgressBar,
  SectionTitle,
  TableCell,
  TableHeader,
  TableRow,
  TripStatusBadge,
} from "../components/ui";
import { DispatchToggle } from "../components/DispatchToggle";
import { LoadCapacityBar } from "../components/LoadCapacityBar";
import { AttentionPanel } from "../components/AttentionPanel";
import { AdminFleetMap } from "../platform/map";
import { ORIGIN_LABEL, cargoSummary, tripDestination, tripProgress } from "../lib/trip";
import type { Truck } from "../types";

export function DashboardWide() {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const openTrips = () => navigation.navigate("AdminTrips");
  const dash = useDashboard();
  const trucks = useTrucks();
  // Only the "recent trips" strip reads this — a small window is plenty.
  const trips = useTrips({}, { limit: 25 });
  const drivers = useDrivers();
  const live = useFleetLive();
  const attention = useAttention();

  if (dash.isLoading || trucks.isLoading) return <Loading />;
  if (dash.isError) return <ErrorState message={t("admin.dashboard.loadError")} onRetry={() => dash.refetch()} />;

  const k = dash.data!;
  const truckList: Truck[] = trucks.data ?? [];
  const recentTrips = (trips.data ?? []).slice(0, 6);
  const liveCount = (live.data ?? []).filter((p) => !p.stale).length;

  // Aggregate alerts: truck doc expiries.
  const docAlerts = truckList.flatMap((tr) => tr.alerts.map((a) => ({ plate: tr.plate, ...a })));

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingVertical: 24, paddingHorizontal: 28, gap: 20 }}
      refreshControl={<RefreshControl refreshing={dash.isRefetching} onRefresh={() => dash.refetch()} />}
    >
      {/* Dispatch mode toggle (Mr. Teh requirement) */}
      <Card pad={14} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <DispatchToggle />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Auto-dispatch failures keep their OWN, distinct signal. The chip
              becomes the trip-board deep link when Trips lands (Phase 4). */}
          {k.auto_dispatch_failed > 0 && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: colors.redTint,
                borderWidth: 1,
                borderColor: colors.red,
                borderRadius: radius.pill,
                paddingVertical: 5,
                paddingHorizontal: 11,
              }}
            >
              <Ionicons name="warning" size={13} color={colors.red} />
              <Text style={{ color: colors.red, fontSize: font.sm, fontWeight: "700" }}>
                {t("admin.dashboard.autoFailed", { count: k.auto_dispatch_failed })}
              </Text>
            </View>
          )}
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
            {t("admin.dashboard.awaitingManual", { count: k.awaiting_manual })}
          </Text>
        </View>
      </Card>

      <AttentionPanel report={attention.data} onOpenBoard={openTrips} />

      {/* KPI cards — the gradient tiles from the web admin. */}
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <KpiCard
            label={t("admin.dashboard.activeTrucks")}
            value={k.active_trucks}
            sub={t("admin.dashboard.ofFleet", { count: k.total_trucks })}
            bg={gradients.blue}
            fg="#fff"
            accent="rgba(255,255,255,0.18)"
            shadowStyle={kpiShadow.blue}
            icon={<Ionicons name="bus-outline" size={18} color="#fff" />}
            onPress={() => navigation.navigate("AdminTrucks")}
          />
        </View>
        <View style={{ flex: 1 }}>
          <KpiCard
            label={t("admin.home.tripsToday")}
            value={k.trips_today}
            sub={t("admin.dashboard.inProgressDone", { inProgress: k.trips_in_progress, done: k.completed_today })}
            bg={gradients.yellow}
            fg={colors.navy}
            accent="rgba(0,48,135,0.12)"
            shadowStyle={kpiShadow.yellow}
            icon={<Ionicons name="location-outline" size={18} color={colors.navy} />}
            onPress={openTrips}
          />
        </View>
        <View style={{ flex: 1 }}>
          <KpiCard
            label={t("admin.dashboard.onTimeRate")}
            value={k.on_time_rate === null ? "—" : `${k.on_time_rate}%`}
            sub={t("admin.dashboard.completedThisMonth")}
            bg={gradients.green}
            fg="#fff"
            accent="rgba(255,255,255,0.18)"
            shadowStyle={kpiShadow.green}
            icon={<Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
            onPress={() => navigation.navigate("AdminPerformance")}
          />
        </View>
        <View style={{ flex: 1 }}>
          <KpiCard
            label={t("admin.dashboard.activeAlerts")}
            value={k.alerts}
            sub={t("admin.dashboard.alertsSub", { doc: docAlerts.length, failed: k.auto_dispatch_failed, awaiting: k.awaiting_manual })}
            bg={gradients.red}
            fg="#fff"
            accent="rgba(255,255,255,0.18)"
            shadowStyle={kpiShadow.red}
            icon={<Ionicons name="warning-outline" size={18} color="#fff" />}
            onPress={() => navigation.navigate("AdminTrucks")}
          />
        </View>
      </View>

      {/* Map + right rail */}
      <View style={{ flexDirection: "row", gap: 16, alignItems: "stretch" }}>
        <Card pad={0} style={{ flex: 1, overflow: "hidden", minHeight: 460 }}>
          <View
            style={{
              paddingVertical: 16,
              paddingHorizontal: 18,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <View style={{ minWidth: 220 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{t("admin.dashboard.fleetMap")}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <LegendDot color={colors.green} label={t("admin.trucks.statusActive")} />
              <LegendDot color={colors.blue} label={t("admin.trucks.statusIdle")} />
              <LegendDot color={colors.orange} label={t("admin.trucks.statusMaintenance")} />
            </View>
          </View>
          <View style={{ flex: 1, padding: 12 }}>
            <AdminFleetMap trucks={truckList} live={live.data ?? []} fill />
          </View>
        </Card>

        <View style={{ width: 340, gap: 16 }}>
          {/* Alerts */}
          <Card>
            <SectionTitle
              title={t("admin.dashboard.fleetAlerts")}
              right={<Pill bg={colors.redTint} fg={colors.red}>{t("admin.dashboard.activeCount", { count: docAlerts.length })}</Pill>}
            />
            {docAlerts.length === 0 ? (
              <EmptyState message={t("admin.dashboard.noExpiries")} />
            ) : (
              <View style={{ gap: 8 }}>
                {docAlerts.map((a, i) => {
                  const tone = alertTone(a.daysLeft);
                  return (
                    <View
                      key={i}
                      style={{
                        backgroundColor: tone.bg,
                        borderLeftWidth: 3,
                        borderLeftColor: tone.fg,
                        borderRadius: radius.sm,
                        paddingVertical: 9,
                        paddingHorizontal: 11,
                      }}
                    >
                      <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>
                        {a.plate} — {t(`admin.dashboard.doc_${a.doc}`)}
                      </Text>
                      <Text style={{ fontSize: font.sm, color: tone.fg, fontWeight: "600" }}>
                        {relativeExpiryLabel(t, a.daysLeft)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </Card>

          {/* Live fleet load (capacity visualiser) */}
          <Card>
            <SectionTitle title={t("admin.dashboard.liveFleetLoad")} subtitle={t("admin.dashboard.trucksCount", { count: truckList.length })} />
            <View style={{ gap: 14 }}>
              {truckList.map((tr) => (
                <View key={tr.plate}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
                    <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>{tr.plate}</Text>
                    <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
                      {tr.driver?.name ?? t("admin.dashboard.unassigned")}
                    </Text>
                  </View>
                  <LoadCapacityBar load={tr.current_load} capacity={tr.max_pallets} compact />
                </View>
              ))}
            </View>
          </Card>
        </View>
      </View>

      {/* Recent trips */}
      <Card pad={0} style={{ overflow: "hidden" }}>
        <View style={{ paddingTop: 18, paddingHorizontal: 20, paddingBottom: 4 }}>
          <SectionTitle
            title={t("admin.dashboard.recentTrips")}
            subtitle={t("admin.dashboard.recentSub")}
            right={
              <Pressable
                onPress={openTrips}
                style={{
                  borderWidth: 1.5,
                  borderColor: colors.blue,
                  borderRadius: radius.pill,
                  paddingVertical: 7,
                  paddingHorizontal: 16,
                }}
              >
                <Text style={{ color: colors.blue, fontWeight: "700", fontSize: font.md }}>{t("admin.dashboard.viewAll")}</Text>
              </Pressable>
            }
          />
        </View>
        {recentTrips.length === 0 ? (
          <EmptyState message={t("admin.dashboard.noTrips")} />
        ) : (
          <View>
            <TableHeader style={{ borderRadius: 0 }}>
              <TableCell flex={1} header>{t("admin.dashboard.colTicket")}</TableCell>
              <TableCell flex={1.7} header>{t("admin.dashboard.colRoute")}</TableCell>
              <TableCell flex={1.1} header>{t("admin.dashboard.colDriver")}</TableCell>
              <TableCell flex={1} header>{t("admin.dashboard.colCargo")}</TableCell>
              <TableCell flex={1} header>{t("admin.dashboard.colStatus")}</TableCell>
              <TableCell flex={1.2} header>{t("admin.dashboard.colProgress")}</TableCell>
            </TableHeader>
            {recentTrips.map((tr) => (
              <TableRow key={tr.id}>
                <TableCell flex={1} textStyle={{ fontWeight: "800", color: colors.blue }}>{tr.ticket_number}</TableCell>
                <TableCell flex={1.7}>
                  <Text numberOfLines={2} style={{ fontSize: font.md }}>
                    <Text style={{ color: colors.textMuted }}>{ORIGIN_LABEL} → </Text>
                    <Text style={{ fontWeight: "600", color: colors.text }}>{tripDestination(tr)}</Text>
                  </Text>
                </TableCell>
                <TableCell flex={1.1} textStyle={{ color: tr.driver ? colors.text : colors.textFaint }}>
                  {tr.driver?.name ?? (tr.is_external ? t("admin.dashboard.external") : "—")}
                </TableCell>
                <TableCell flex={1}>{cargoSummary(tr)}</TableCell>
                <TableCell flex={1}><TripStatusBadge status={tr.status} /></TableCell>
                <TableCell flex={1.2}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <ProgressBar pct={tripProgress(tr)} color={tr.status === "completed" ? colors.green : colors.blue} />
                    </View>
                    <Text style={{ fontSize: font.xs, fontWeight: "700", color: colors.textMuted, width: 34 }}>
                      {tripProgress(tr)}%
                    </Text>
                  </View>
                </TableCell>
              </TableRow>
            ))}
          </View>
        )}
      </Card>

      {drivers.data && (
        <Text style={{ fontSize: font.sm, color: colors.textFaint }}>
          {t("admin.dashboard.driversFootnote", {
            onRoute: drivers.data.filter((d) => d.status === "on_trip").length,
            available: drivers.data.filter((d) => d.status === "available").length,
          })}
        </Text>
      )}
    </ScrollView>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}

function alertTone(daysLeft: number) {
  if (daysLeft < 0) return { bg: colors.redTint, fg: colors.red };
  if (daysLeft <= 14) return { bg: colors.orangeTint, fg: colors.orange };
  return { bg: colors.yellowTint, fg: colors.amber };
}

// i18n form of lib/format's relativeExpiry (the ported lib stays untouched).
function relativeExpiryLabel(t: (k: string, o?: Record<string, unknown>) => string, daysLeft: number): string {
  if (daysLeft < 0) return t("admin.dashboard.expiredAgo", { count: Math.abs(daysLeft) });
  if (daysLeft === 0) return t("admin.dashboard.expiresToday");
  return t("admin.dashboard.expiresIn", { count: daysLeft });
}
