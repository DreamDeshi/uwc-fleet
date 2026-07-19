import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { initials } from "../../lib/format";
import { AppLanguage } from "../../types";
import { EditProfileModal, ChangePasswordModal } from "../../components/AccountModals";

export function ProfileScreen() {
  const { t, i18n } = useTranslation();
  const { user, logout, setLanguage } = useAuth();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const lang: AppLanguage = (["en", "ms", "zh"] as const).includes(i18n.language as AppLanguage)
    ? (i18n.language as AppLanguage)
    : "en";
  const langLabels: Record<AppLanguage, string> = {
    en: t("profile.english"),
    ms: t("profile.malay"),
    zh: t("profile.chinese"),
  };

  const rows: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { label: t("profile.role"), value: user?.role ?? "—", icon: "person-outline" },
    { label: t("profile.phone"), value: user?.phone ?? "—", icon: "call-outline" },
    { label: t("profile.employeeNumber"), value: user?.employee_number ?? "—", icon: "id-card-outline" },
    { label: t("profile.department"), value: user?.department?.name ?? "—", icon: "business-outline" },
  ];

  return (
    <View style={styles.fill}>
      <Header title={t("profile.title")} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, width: "100%", maxWidth: layout.content, alignSelf: "center" }}>
        {/* Identity card */}
        <Card style={{ alignItems: "center", paddingVertical: 24 }}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(user?.name ?? "")}</Text>
          </View>
          <Text style={styles.name}>{user?.name}</Text>
          {user?.assigned_truck ? (
            <View style={styles.truckPill}>
              <MaterialCommunityIcons name="truck" size={14} color={colors.blue} />
              <Text style={styles.truckText}>
                {user.assigned_truck.plate} · {user.assigned_truck.type}
              </Text>
            </View>
          ) : null}
        </Card>

        {/* Info rows */}
        <Card style={{ marginTop: 16 }} padded={false}>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.infoRow, i < rows.length - 1 && styles.divider]}>
              <Ionicons name={r.icon} size={18} color={colors.textFaint} />
              <Text style={styles.infoLabel}>{r.label}</Text>
              <Text style={styles.infoValue}>{r.value}</Text>
            </View>
          ))}
        </Card>

        {/* Account actions (any role) — edit own name/department + password */}
        <Text style={styles.sectionTitle}>{t("account.section")}</Text>
        <Button
          title={t("account.editProfile")}
          variant="outline"
          onPress={() => setEditOpen(true)}
          icon={<Ionicons name="create-outline" size={18} color={colors.blue} />}
        />
        <Button
          title={t("account.changePassword")}
          variant="outline"
          onPress={() => setPwOpen(true)}
          style={{ marginTop: 10 }}
          icon={<Ionicons name="lock-closed-outline" size={18} color={colors.blue} />}
        />

        {/* Fuel logging moved to the driver Home as a quick-action (a driver
            logs a fill-up often — it belongs on the dashboard, not in Settings). */}

        {/* Language picker (EN / BM) */}
        <Text style={styles.sectionTitle}>{t("profile.language")}</Text>
        <View style={styles.langRow}>
          {(["en", "ms", "zh"] as const).map((l) => {
            const active = lang === l;
            return (
              <TouchableOpacity
                key={l}
                style={[styles.langBtn, active && styles.langBtnActive]}
                onPress={() => setLanguage(l)}
              >
                <Text style={[styles.langText, active && { color: colors.blue }]}>
                  {langLabels[l]}
                </Text>
                {active ? <Ionicons name="checkmark-circle" size={18} color={colors.blue} /> : null}
              </TouchableOpacity>
            );
          })}
        </View>

        <Button
          title={t("profile.logout")}
          variant="danger"
          onPress={() => setConfirmLogout(true)}
          style={{ marginTop: 24 }}
          icon={<Ionicons name="log-out-outline" size={18} color={colors.white} />}
        />
      </ScrollView>

      <Modal visible={confirmLogout} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>{t("profile.logoutConfirm")}</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 20 }}>
              <Button title={t("common.cancel")} variant="outline" onPress={() => setConfirmLogout(false)} style={{ flex: 1 }} />
              <Button title={t("profile.logout")} variant="danger" onPress={logout} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>

      <EditProfileModal visible={editOpen} onClose={() => setEditOpen(false)} />
      <ChangePasswordModal visible={pwOpen} onClose={() => setPwOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.yellow },
  avatarText: { color: colors.yellow, fontSize: 24, fontWeight: "800" },
  name: { fontSize: 18, fontWeight: "800", color: colors.navy, marginTop: 12 },
  truckPill: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, backgroundColor: colors.tintBlue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill },
  truckText: { color: colors.blue, fontSize: 13, fontWeight: "700" },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  infoLabel: { fontSize: 14, color: colors.textMuted },
  infoValue: { marginLeft: "auto", fontSize: 14, fontWeight: "700", color: colors.navy, textTransform: "capitalize" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy, marginTop: 24, marginBottom: 12 },
  langRow: { gap: 10 },
  langBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.white, borderRadius: radius.md, padding: 16, borderWidth: 1.5, borderColor: colors.border, ...shadow.card },
  langBtnActive: { borderColor: colors.blue, borderWidth: 2, backgroundColor: colors.tintBlue },
  langText: { fontSize: 15, fontWeight: "700", color: colors.textMuted },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 24, width: "100%" },
  modalTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
});
