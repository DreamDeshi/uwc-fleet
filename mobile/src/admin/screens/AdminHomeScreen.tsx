// Admin landing — built in the SAME design language as the driver/requestor
// homes (owner direction, 13 Jul 2026): blue greeting header ("Good evening,
// name 👋", 26/800 scale, yellow-ringed avatar, context line), a floating
// action card overlapping the header, tinted stat boxes, and section-titled
// card lists. Admin content, app-native feel. Data comes from the already-
// ported hooks (useDashboard 30s poll, usePendingUsers) — read-only, no new
// logic. Phase 3 grows this screen into the full dashboard (map, KPIs).
import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { DrawerNavigationProp } from "@react-navigation/drawer";
import type { ParamListBase } from "@react-navigation/native";
import { useAuth } from "../../context/AuthContext";
import { useDashboard, usePendingUsers } from "../hooks/queries";
import { colors, font, radius, shadow } from "../theme";
import { initials } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";

function greetingKey(hour: number): "goodMorning" | "goodAfternoon" | "goodEvening" {
  if (hour < 12) return "goodMorning";
  if (hour < 18) return "goodAfternoon";
  return "goodEvening";
}

export function AdminHomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<DrawerNavigationProp<ParamListBase>>();
  const { user } = useAuth();
  const mode = useLayoutMode();
  const dashboard = useDashboard();
  const pending = usePendingUsers();

  const greeting = t(`admin.home.${greetingKey(new Date().getHours())}`);
  const pendingCount = pending.data?.length ?? 0;
  const k = dashboard.data;
  const refreshing = dashboard.isRefetching || pending.isRefetching;
  const refetchAll = () => {
    dashboard.refetch();
    pending.refetch();
  };

  const live = [
    { route: "AdminApprovals", labelKey: "admin.nav.approvals", icon: "person-add-outline" as const, count: pendingCount },
    { route: "AdminConsignees", labelKey: "admin.nav.consignees", icon: "business-outline" as const },
    { route: "AdminPerformance", labelKey: "admin.nav.performance", icon: "trophy-outline" as const },
  ];

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      {/* Greeting header — the requestor/driver home header, admin-flavoured. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        {mode === "narrow" && (
          <Pressable
            onPress={() => navigation.toggleDrawer()}
            accessibilityLabel="Open menu"
            style={styles.menuBtn}
          >
            <Ionicons name="menu" size={20} color="#fff" />
          </Pressable>
        )}
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
        {/* Floating action card — the admin's "where to?": the approval queue. */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            style={styles.cta}
            activeOpacity={0.9}
            onPress={() => navigation.navigate("AdminApprovals")}
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

        {/* Today — a taste of the dashboard (Phase 3 brings the full thing). */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("admin.home.today")}</Text>
          <View style={styles.statRow}>
            <StatBox value={k ? k.trips_today : null} label={t("admin.home.tripsToday")} color={colors.blue} bg={colors.blueTint} />
            <StatBox value={k ? k.trips_in_progress : null} label={t("admin.home.inProgress")} color={colors.violet} bg={colors.violetTint} />
            <StatBox value={k ? k.completed_today : null} label={t("admin.home.completedToday")} color={colors.green} bg={colors.greenTint} />
          </View>
        </View>

        {/* Manage — the live admin screens as a tappable card list. */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("admin.home.manage")}</Text>
          <View style={styles.listCard}>
            {live.map((item, i) => (
              <TouchableOpacity
                key={item.route}
                style={[styles.listRow, i < live.length - 1 && styles.divider]}
                onPress={() => navigation.navigate(item.route)}
              >
                <View style={styles.listIcon}>
                  <Ionicons name={item.icon} size={18} color={colors.blue} />
                </View>
                <Text style={styles.listLabel}>{t(item.labelKey)}</Text>
                {item.count !== undefined && item.count > 0 && (
                  <View style={styles.countPill}>
                    <Text style={styles.countPillText}>{item.count}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </TouchableOpacity>
            ))}
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

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 44 },
  menuBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
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

  listCard: { backgroundColor: "#fff", borderRadius: radius.lg, marginTop: 12, ...shadow.card, borderWidth: 1, borderColor: colors.border },
  listRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  listIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  listLabel: { flex: 1, fontSize: font.md, fontWeight: "600", color: colors.text },
});
