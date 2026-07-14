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
import { useAttention, useDashboard, useFleetLive, usePendingUsers, useTrucks } from "../hooks/queries";
import { colors, font, radius, shadow } from "../theme";
import { initials } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { AttentionPanel, attentionHasRows } from "../components/AttentionPanel";
import { AdminFleetMap } from "../platform/map";
import { DashboardWide } from "./DashboardWide";

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
  const attention = useAttention();
  const trucks = useTrucks();
  const live = useFleetLive();

  const greeting = t(`admin.home.${greetingKey(new Date().getHours())}`);
  const pendingCount = pending.data?.length ?? 0;
  const k = dashboard.data;
  const liveCount = (live.data ?? []).filter((p) => !p.stale).length;
  const refreshing = dashboard.isRefetching || pending.isRefetching || attention.isRefetching;
  const refetchAll = () => {
    dashboard.refetch();
    pending.refetch();
    attention.refetch();
    trucks.refetch();
    live.refetch();
  };

  // PC gets the real dashboard; the merged home below is mobile-only.
  if (mode === "wide") return <DashboardWide />;

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      {/* Greeting header — the requestor/driver home header, admin-flavoured. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.greetingTime}>{greeting} 👋</Text>
            <Text numberOfLines={1} style={styles.hi}>{user?.name ?? ""}</Text>
            <View style={styles.roleRow}>
              <Ionicons name="shield-checkmark-outline" size={12} color="rgba(255,255,255,0.65)" />
              <Text style={styles.role}>{t("admin.roleLabel")}</Text>
            </View>
          </View>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(user?.name ?? "")}</Text>
          </View>
        </View>
      </View>

      <View style={styles.content}>
        {/* Floating action card — the admin's "where to?": the approval queue
            (now inside the MORE tab's stack). */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            style={styles.cta}
            activeOpacity={0.9}
            onPress={() => navigation.navigate("AdminMore", { screen: "AdminApprovals", initial: false })}
          >
            <View style={styles.ctaIcon}>
              <Ionicons name="person-add" size={22} color={colors.blue} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.ctaTitle}>{t("admin.home.approvalQueue")}</Text>
              <Text style={styles.ctaSub}>
                {pendingCount > 0
                  ? t("admin.home.pendingSub", { count: pendingCount })
                  : t("admin.home.allClear")}
              </Text>
            </View>
            {pendingCount > 0 && (
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{pendingCount}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color={colors.blue} />
          </TouchableOpacity>
        </View>

        {/* Today — the dashboard's headline numbers. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("admin.home.today")}</Text>
          <View style={styles.statRow}>
            <StatBox value={k ? k.trips_today : null} label={t("admin.home.tripsToday")} color={colors.blue} bg={colors.blueTint} />
            <StatBox value={k ? k.trips_in_progress : null} label={t("admin.home.inProgress")} color={colors.violet} bg={colors.violetTint} />
            <StatBox value={k ? k.completed_today : null} label={t("admin.home.completedToday")} color={colors.green} bg={colors.greenTint} />
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
              <Text style={styles.mapSub}>
                {liveCount > 0
                  ? t("admin.dashboard.mapSubLive", { count: liveCount })
                  : t("admin.dashboard.mapSubAwaiting")}
              </Text>
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <LegendDot color={colors.green} label={t("admin.trucks.statusActive")} />
                <LegendDot color={colors.blue} label={t("admin.trucks.statusIdle")} />
                <LegendDot color={colors.orange} label={t("admin.trucks.statusMaintenance")} />
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

function StatBox({ value, label, color, bg }: { value: number | null; label: string; color: string; bg: string }) {
  return (
    <View style={[styles.statBox, { backgroundColor: bg }]}>
      <Text style={[styles.statValue, { color }]}>{value ?? "—"}</Text>
      <Text style={[styles.statLabel, { color }]} numberOfLines={1}>{label}</Text>
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
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    ...shadow.floating,
  },
  ctaIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  ctaTitle: { fontSize: font.lg, fontWeight: "700", color: colors.navy },
  ctaSub: { fontSize: font.md, color: colors.textFaint },
  countPill: { backgroundColor: colors.red, borderRadius: radius.pill, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  countPillText: { color: "#fff", fontSize: font.xs, fontWeight: "800" },

  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },

  statRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  statBox: { flex: 1, borderRadius: radius.md, padding: 14, alignItems: "center" },
  statValue: { fontSize: 26, fontWeight: "900" },
  statLabel: { fontSize: font.xs, fontWeight: "700", textTransform: "uppercase", marginTop: 3 },

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
});
