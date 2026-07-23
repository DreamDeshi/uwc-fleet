// Admin landing — split by layout (owner direction, 13 Jul 2026):
//   NARROW (phone): HOME — the greeting home and the dashboard MERGED into
//   the one landing screen of the bottom-tab shell (mobile polish pass,
//   14 Jul 2026): greeting header, approval-queue action card, today's
//   stats, the attention panel (deep-links to the Trips tab) and the
//   Phase-3 fleet map. The old "Manage" list moved to the MORE tab; the
//   hamburger is gone (bottom bar replaced the drawer).
//   WIDE (PC): the old web admin's dashboard layout instead — dispatch
//   bar, attention panel, gradient KPI tiles, map + rail, recent trips
//   (DashboardWide.tsx). Untouched by the mobile pass.
// Data comes from the already-ported hooks — read-only, no new logic.
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { useAuth } from "../../context/AuthContext";
import { useAttention, useDashboard, useFleetLive, usePendingApprovals, usePendingUsers, useTrucks } from "../hooks/queries";
import { colors, font, radius, shadow } from "../theme";
import { BrandLogo } from "../../components/BrandLogo";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { AttentionPanel, attentionHasRows } from "../components/AttentionPanel";
import { AdminSearchButton } from "../components/AdminSearchButton";
import { AdminFleetMap } from "../platform/map";
import { DashboardWide } from "./DashboardWide";

type IoniconName = keyof typeof Ionicons.glyphMap;

function greetingKey(hour: number): "goodMorning" | "goodAfternoon" | "goodEvening" {
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

export function AdminHomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const { user } = useAuth();
  const mode = useLayoutMode();
  const dashboard = useDashboard();
  const pending = usePendingUsers();
  const pendingApprovals = usePendingApprovals();
  const attention = useAttention();
  const trucks = useTrucks();
  const live = useFleetLive();

  const greeting = t(`admin.home.${greetingKey(new Date().getHours())}`);
  const pendingCount = pending.data?.length ?? 0;
  const approvalCount = pendingApprovals.data?.length ?? 0;
  const k = dashboard.data;
  const liveCount = (live.data ?? []).filter((p) => !p.stale).length;
  const refreshing = dashboard.isRefetching || pending.isRefetching || attention.isRefetching;
  const refetchAll = () => {
    dashboard.refetch();
    pending.refetch();
    pendingApprovals.refetch();
    attention.refetch();
    trucks.refetch();
    live.refetch();
  };

  // PC gets the real dashboard; the merged home below is mobile-only.
  if (mode === "wide") return <DashboardWide />;

  // Promoted MORE functions as a 4-across tap grid — same destinations, new
  // entry points. Users carries the pending-users badge, subsuming the old
  // approvals row that used to sit below the map.
  const quickTiles: { route: string; labelKey: string; icon: IoniconName; count?: number }[] = [
    { route: "AdminIncentiveApprovals", labelKey: "admin.nav.incentiveApprovals", icon: "checkmark-done-outline", count: approvalCount },
    { route: "AdminIncentives", labelKey: "admin.nav.incentives", icon: "cash-outline" },
    { route: "AdminReports", labelKey: "admin.nav.reports", icon: "bar-chart-outline" },
    { route: "AdminConsignees", labelKey: "admin.nav.consignees", icon: "business-outline" },
    { route: "AdminUsers", labelKey: "admin.users.title", icon: "people-outline", count: pendingCount },
    { route: "AdminPerformance", labelKey: "admin.nav.performance", icon: "trophy-outline" },
    { route: "AdminCalendar", labelKey: "admin.nav.calendar", icon: "calendar-outline" },
  ];

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      {/* Greeting header — the requestor/driver home header, admin-flavoured. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTop}>
          <BrandLogo white mark height={30} style={{ marginRight: 12 }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.greetingTime}>{greeting} 👋</Text>
            <Text numberOfLines={1} style={styles.hi}>{user?.name ?? ""}</Text>
            <View style={styles.roleRow}>
              <Ionicons name="shield-checkmark-outline" size={12} color="rgba(255,255,255,0.65)" />
              <Text style={styles.role}>{t("admin.roleLabel")}</Text>
            </View>
          </View>
          <AdminSearchButton />
        </View>
      </View>

      <View style={styles.content}>
        {/* Floating hero — the dispatcher's live snapshot; taps to the board.
            (Approvals moved down to a normal row — it's not the main job.) */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            style={styles.cta}
            activeOpacity={0.9}
            onPress={() => navigation.navigate("AdminTrips")}
          >
            <View style={styles.heroHead}>
              <View style={styles.ctaIcon}>
                <Ionicons name="flash" size={16} color={colors.blue} />
              </View>
              <Text style={styles.ctaTitle}>{t("admin.home.dispatchTitle")}</Text>
              <Ionicons name="chevron-forward" size={20} color={colors.blue} />
            </View>
            <View style={styles.heroStats}>
              <HeroStat value={k ? k.trips_in_progress : null} label={t("admin.home.inProgress")} color={colors.violet} />
              <View style={styles.heroDivider} />
              <HeroStat value={k ? k.awaiting_manual : null} label={t("admin.home.awaitingDispatch")} color={colors.orange} />
              <View style={styles.heroDivider} />
              <HeroStat
                value={k ? k.auto_dispatch_failed : null}
                label={t("admin.trips.needsAttention")}
                color={k && k.auto_dispatch_failed > 0 ? colors.red : colors.green}
              />
            </View>
            {/* Subtle day-progress line — the day's context in one muted row,
                not a second wall of stat boxes. */}
            {k && (
              <View style={styles.heroFooter}>
                <Text style={styles.heroFooterText}>
                  {t("admin.home.daySummary", {
                    trips: k.trips_today,
                    completed: k.completed_today,
                    trucks: k.active_trucks,
                  })}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Quick actions — the important admin functions promoted out of MORE
            as a 4-across tap grid. Same destinations, new entry points. */}
        <View style={styles.section}>
          <View style={styles.gridCard}>
            {quickTiles.map((tile) => (
              <TouchableOpacity
                key={tile.route}
                style={styles.tile}
                activeOpacity={0.7}
                onPress={() => navigation.navigate("AdminMore", { screen: tile.route, initial: false })}
              >
                <View style={styles.tileIcon}>
                  <Ionicons name={tile.icon} size={22} color={colors.blue} />
                  {tile.count ? (
                    <View style={styles.tileBadge}>
                      <Text style={styles.tileBadgeText}>{tile.count > 99 ? "99+" : tile.count}</Text>
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={2} style={styles.tileLabel}>{t(tile.labelKey)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Needs attention — same panel as the PC dashboard; hidden when the
            fleet is healthy. "Open trip board" jumps to the Trips tab. */}
        {attentionHasRows(attention.data) && (
          <View style={styles.section}>
            <AttentionPanel report={attention.data} onOpenBoard={() => navigation.navigate("AdminTrips")} />
          </View>
        )}

        {/* Fleet map — the Phase-3 map, now on the phone home too. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("admin.dashboard.fleetMap")}</Text>
          <View style={styles.mapCard}>
            <View style={styles.mapHead}>
              {/* Only active trucks (with a real fix) are markers now; idle /
                  maintenance moved into the map's Idle side list. */}
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <LegendDot color={colors.green} label={t("admin.trucks.statusActive")} />
              </View>
            </View>
            <View style={{ padding: 10 }}>
              <AdminFleetMap trucks={trucks.data ?? []} live={live.data ?? []} height={280} />
            </View>
          </View>
        </View>

      </View>
    </ScrollView>
  );
}

function HeroStat({ value, label, color }: { value: number | null; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      <Text style={{ fontSize: 24, fontWeight: "900", color }}>{value ?? "—"}</Text>
      <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textMuted, textAlign: "center", marginTop: 2 }}>
        {label}
      </Text>
    </View>
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

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 44 },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  // Same greeting scale as the requestor/driver homes (owner-approved balance).
  greetingTime: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "700" },
  hi: { color: "#fff", fontSize: 26, fontWeight: "800", marginTop: 3 },
  roleRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  role: { color: "rgba(255,255,255,0.7)", fontSize: font.md },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderWidth: 2,
    borderColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 15, fontWeight: "800" },

  // Wide screens center the content column like the other admin screens.
  content: { width: "100%", maxWidth: 1000, alignSelf: "center" },

  ctaWrap: { paddingHorizontal: 20, marginTop: -28 },
  cta: {
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    padding: 11,
    gap: 8,
    ...shadow.floating,
  },
  heroHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroStats: { flexDirection: "row", alignItems: "center" },
  heroDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.divider },
  heroFooter: { borderTopWidth: 1, borderTopColor: colors.divider, marginTop: 8, paddingTop: 8, alignItems: "center" },
  heroFooterText: { fontSize: font.sm, color: colors.textMuted, fontWeight: "600" },
  ctaIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  ctaTitle: { flex: 1, fontSize: font.lg, fontWeight: "700", color: colors.navy },
  countPill: { backgroundColor: colors.red, borderRadius: radius.pill, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  countPillText: { color: "#fff", fontSize: font.xs, fontWeight: "800" },

  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  rowCard: { backgroundColor: colors.card, borderRadius: radius.lg, marginTop: 4, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  rowLabel: { fontSize: font.md, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: font.sm, color: colors.textFaint, marginTop: 1 },

  mapCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 12,
    overflow: "hidden",
    ...shadow.card,
  },
  mapHead: {
    paddingTop: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  mapSub: { fontSize: font.sm, color: colors.textMuted, flexShrink: 1 },

  // Quick-action grid — Shopee/TNG-style tap tiles, 4 across (last row of 3
  // left-aligns). Each tile is 25% wide so 4 fit per row exactly.
  gridCard: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    marginTop: 4,
    ...shadow.card,
  },
  tile: { width: "25%", alignItems: "center", paddingVertical: 10, paddingHorizontal: 4 },
  tileIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  tileBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    backgroundColor: colors.red,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.card,
  },
  tileBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  tileLabel: { fontSize: 11, fontWeight: "600", color: colors.text, textAlign: "center", marginTop: 6, lineHeight: 14 },
});
