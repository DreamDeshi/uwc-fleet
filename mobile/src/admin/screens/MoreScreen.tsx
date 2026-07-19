// MORE — mobile-only tab (bottom-bar shell, 14 Jul 2026): everything that
// isn't Home/Trips/Fleet as a clean icon+label+chevron list (the greeting
// home's "Manage" card pattern), plus the signed-in admin card and sign-out
// that used to live in the drawer. Wide keeps the sidebar (PC untouched).
import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { useAuth } from "../../context/AuthContext";
import { usePendingApprovals, usePendingUsers } from "../hooks/queries";
import { colors, font, radius, shadow } from "../theme";
import { Avatar, ConfirmDialog } from "../components/ui";

type IoniconName = keyof typeof Ionicons.glyphMap;

export function MoreScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const { user, logout } = useAuth();
  const pending = usePendingUsers();
  const pendingApprovals = usePendingApprovals();
  const pendingCount = pending.data?.length ?? 0;
  const approvalCount = pendingApprovals.data?.length ?? 0;
  const [confirmOut, setConfirmOut] = useState(false);

  // Same icons the drawer used for these routes.
  const rows: { route: string; labelKey: string; icon: IoniconName; count?: number }[] = [
    { route: "AdminIncentiveApprovals", labelKey: "admin.nav.incentiveApprovals", icon: "checkmark-done-outline", count: approvalCount },
    { route: "AdminIncentives", labelKey: "admin.nav.incentives", icon: "cash-outline" },
    { route: "AdminReports", labelKey: "admin.nav.reports", icon: "bar-chart-outline" },
    { route: "AdminConsignees", labelKey: "admin.nav.consignees", icon: "business-outline" },
    { route: "AdminUsers", labelKey: "admin.users.title", icon: "people-outline", count: pendingCount },
    { route: "AdminPerformance", labelKey: "admin.nav.performance", icon: "trophy-outline" },
    // Search moved onto the dashboard; Audit log moved into Settings (below) —
    // neither is a top-level MORE row now.
  ];

  return (
    <ScrollView style={styles.fill} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      {/* Signed-in admin (the drawer's identity card, light-surface form) */}
      <View style={[styles.card, styles.identity]}>
        <Avatar name={user?.name} size={44} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.name}>{user?.name ?? "—"}</Text>
          <Text style={styles.role}>{t("admin.roleLabel")}</Text>
        </View>
      </View>

      <View style={[styles.card, { marginTop: 16 }]}>
        {rows.map((item, i) => (
          <TouchableOpacity
            key={item.route}
            style={[styles.row, i < rows.length - 1 && styles.divider]}
            onPress={() => navigation.navigate(item.route)}
          >
            <View style={styles.rowIcon}>
              <Ionicons name={item.icon} size={18} color={colors.blue} />
            </View>
            <Text style={styles.rowLabel}>{t(item.labelKey)}</Text>
            {item.count !== undefined && item.count > 0 && (
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{item.count}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        ))}
      </View>

      {/* Settings (language & preferences) — the admin's profile-area entry,
          same screen the PC sidebar's System group opens. */}
      <View style={[styles.card, { marginTop: 16 }]}>
        <TouchableOpacity style={styles.row} onPress={() => navigation.navigate("AdminSettings")}>
          <View style={styles.rowIcon}>
            <Ionicons name="settings-outline" size={18} color={colors.blue} />
          </View>
          <Text style={styles.rowLabel}>{t("admin.nav.settings")}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </TouchableOpacity>
      </View>

      {/* Sign out — confirmed first (mobile pattern, same as Profile). */}
      <View style={[styles.card, { marginTop: 16 }]}>
        <TouchableOpacity style={styles.row} onPress={() => setConfirmOut(true)}>
          <View style={[styles.rowIcon, { backgroundColor: colors.redTint }]}>
            <Ionicons name="log-out-outline" size={18} color={colors.red} />
          </View>
          <Text style={[styles.rowLabel, { color: colors.red }]}>{t("admin.signOut")}</Text>
        </TouchableOpacity>
      </View>

      {confirmOut && (
        <ConfirmDialog
          title={t("admin.signOut")}
          body={t("profile.logoutConfirm")}
          confirmLabel={t("admin.signOut")}
          onClose={() => setConfirmOut(false)}
          onConfirm={logout}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  identity: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  name: { fontSize: font.lg, fontWeight: "700", color: colors.text },
  role: { fontSize: font.sm, color: colors.textMuted, marginTop: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.blueTint, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: font.md, fontWeight: "600", color: colors.text },
  countPill: { backgroundColor: colors.red, borderRadius: radius.pill, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  countPillText: { color: "#fff", fontSize: font.xs, fontWeight: "800" },
});
