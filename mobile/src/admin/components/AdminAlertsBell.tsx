// Header notification bell → alerts panel (owner ask, 2026-07-19: "the bell
// does nothing"). It now opens a popover summarising the actionable queues that
// already exist elsewhere — pending account approvals, POD incentive approvals,
// truck document expiries, auto-dispatch failures — each row jumping to the
// screen that handles it. Purely SUPPLEMENTARY: every one of these is still
// reachable by normal navigation; the bell is a shortcut, not the only path.
import React, { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDashboard, usePendingApprovals, usePendingUsers, useTruckAlerts } from "../hooks/queries";
import { colors, font, radius } from "../theme";

type IoniconName = keyof typeof Ionicons.glyphMap;

export function AdminAlertsBell() {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const pendingUsers = usePendingUsers().data?.length ?? 0;
  const podApprovals = usePendingApprovals().data?.length ?? 0;
  const truckDocs = useTruckAlerts().data?.length ?? 0;
  const autoFailed = useDashboard().data?.auto_dispatch_failed ?? 0;

  const allRows: { key: string; icon: IoniconName; label: string; count: number; route: string }[] = [
    { key: "auto", icon: "warning-outline", label: t("admin.alerts.autoFailed", { count: autoFailed }), count: autoFailed, route: "AdminTrips" },
    { key: "pod", icon: "checkmark-done-outline", label: t("admin.alerts.podApprovals", { count: podApprovals }), count: podApprovals, route: "AdminIncentiveApprovals" },
    { key: "users", icon: "people-outline", label: t("admin.alerts.pendingUsers", { count: pendingUsers }), count: pendingUsers, route: "AdminUsers" },
    { key: "trucks", icon: "bus-outline", label: t("admin.alerts.truckDocs", { count: truckDocs }), count: truckDocs, route: "AdminTrucks" },
  ];
  const rows = allRows.filter((r) => r.count > 0);

  const total = pendingUsers + podApprovals + truckDocs + autoFailed;

  const go = (route: string) => {
    setOpen(false);
    navigation.navigate(route);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityLabel={t("admin.alerts.title")}
        style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" }}
      >
        <Ionicons name="notifications-outline" size={18} color="#fff" />
        {total > 0 && (
          <View
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              minWidth: 16,
              height: 16,
              paddingHorizontal: 4,
              backgroundColor: colors.red,
              borderRadius: 8,
              borderWidth: 1.5,
              borderColor: colors.blue,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>{total}</Text>
          </View>
        )}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Full-screen backdrop closes on outside tap. */}
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)}>
          <View
            style={{
              position: "absolute",
              top: insets.top + 58,
              right: 20,
              width: 320,
              maxWidth: "92%",
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              overflow: "hidden",
              shadowColor: "#000",
              shadowOpacity: 0.2,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 10 },
              elevation: 10,
            }}
          >
            <View style={{ paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
              <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{t("admin.alerts.title")}</Text>
            </View>

            {rows.length === 0 ? (
              <View style={{ padding: 20, alignItems: "center", gap: 8 }}>
                <Ionicons name="checkmark-circle-outline" size={26} color={colors.green} />
                <Text style={{ fontSize: font.sm, color: colors.textMuted, textAlign: "center" }}>{t("admin.alerts.empty")}</Text>
              </View>
            ) : (
              rows.map((r, i) => (
                <Pressable
                  key={r.key}
                  onPress={() => go(r.route)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 13,
                    paddingHorizontal: 14,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: colors.divider,
                  }}
                >
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: colors.redTint, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name={r.icon} size={16} color={colors.red} />
                  </View>
                  <Text style={{ flex: 1, fontSize: font.sm, fontWeight: "600", color: colors.text }}>{r.label}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                </Pressable>
              ))
            )}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
