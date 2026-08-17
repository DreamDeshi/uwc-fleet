import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RequestorStackParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { colors, layout, radius, shadow } from "../../theme";
import { Button } from "../../components/Button";
import { initials } from "../../lib/format";
import { AppLanguage } from "../../types";
import { EditProfileModal, ChangePasswordModal } from "../../components/AccountModals";
import { FeedbackModal } from "../../components/FeedbackModal";
import { AppUpdatesCard } from "../../components/AppUpdatesCard";
import { OutdoorModeRow } from "../../components/OutdoorModeRow";
import { formatPalletSpaces } from "../../lib/pallets";
import { BiometricUnlockRow } from "../../components/BiometricUnlockRow";

// Profile, rebuilt to the approved design (frame 37).
//
// Identity moves ONTO the blue: avatar, name, and one subtitle that folds the
// three facts that used to each own a row (role · department · employee
// number). What is left below is plainly secondary — which is the point of the
// frame's note, "nothing below competes".
//
// Shared with the requestor role. The plate chip is the driver-only slot: it
// renders only when a truck is assigned, which no requestor has.
export function ProfileScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  // Typed against the requestor stack because only the requestor rows navigate;
  // on the driver stack those rows are never rendered, so the routes are never
  // reached from there.
  const navigation = useNavigation<NativeStackNavigationProp<RequestorStackParamList>>();
  const { user, logout, setLanguage } = useAuth();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const lang: AppLanguage = (["en", "ms", "zh"] as const).includes(i18n.language as AppLanguage)
    ? (i18n.language as AppLanguage)
    : "en";
  const langLabels: Record<AppLanguage, string> = {
    en: t("profile.english"),
    ms: t("profile.malay"),
    zh: t("profile.chinese"),
  };

  // Role · Department · Employee number, as one line under the name. Empty
  // parts drop out rather than leaving stray separators.
  //
  // Reuses the register namespace's role labels — they are already translated
  // in all three locales, and "Driver"/"Requestor" mean the same thing here as
  // they do on the sign-up form.
  const roleLabel =
    user?.role === "driver"
      ? t("register.roleDriver")
      : user?.role === "requestor"
        ? t("register.roleRequestor")
        : (user?.role ?? "");
  const subtitle = [roleLabel, user?.department?.name, user?.employee_number]
    .filter(Boolean)
    .join(" · ");

  const rows: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { label: t("profile.phone"), value: user?.phone ?? "—", icon: "call-outline" },
    { label: t("profile.employeeNumber"), value: user?.employee_number ?? "—", icon: "id-card-outline" },
    { label: t("profile.department"), value: user?.department?.name ?? "—", icon: "business-outline" },
  ];

  // The requestor design (frame 12) adds two shortcuts to things that only
  // existed inside the booking form. They are REQUESTOR-ONLY: a driver has no
  // consignee list of their own and books nothing, so the rows would be dead
  // ends on the shared screen.
  const isRequestor = user?.role === "requestor";
  const actions: { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void }[] = [
    ...(isRequestor
      ? ([
          {
            label: t("account.savedConsignees"),
            icon: "people-outline" as const,
            onPress: () => navigation.navigate("SavedConsignees"),
          },
          {
            label: t("account.bookingTemplates"),
            icon: "repeat-outline" as const,
            onPress: () => navigation.navigate("BookingTemplates"),
          },
        ])
      : []),
    { label: t("account.editProfile"), icon: "create-outline", onPress: () => setEditOpen(true) },
    { label: t("account.changePassword"), icon: "lock-closed-outline", onPress: () => setPwOpen(true) },
    { label: t("feedback.title"), icon: "megaphone-outline", onPress: () => setFeedbackOpen(true) },
  ];

  return (
    <View style={styles.fill}>
      {/* Identity ON the blue — replaces the old <Header title="Profile"> plus
          a white identity card underneath it. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.centerCol}>
          <View style={styles.identityRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(user?.name ?? "")}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.name} numberOfLines={2}>{user?.name}</Text>
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
          </View>
          {user?.assigned_truck ? (
            <View style={styles.truckRow}>
              {/* Styled like a real number plate — it is the thing a driver
                  checks against the lorry in front of him. */}
              <View style={styles.plate}>
                <Text style={styles.plateText}>{user.assigned_truck.plate}</Text>
              </View>
              <Text style={styles.truckMeta} numberOfLines={1}>
                {user.assigned_truck.type} · {t("driver.palletCount", { spaces: formatPalletSpaces(user.assigned_truck.max_pallets) })}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Facts the office owns — read-only, plainly secondary. */}
        <View style={styles.card}>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.row, i < rows.length - 1 && styles.rowDivider]}>
              <Ionicons name={r.icon} size={18} color={colors.textFaint} />
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowValue} numberOfLines={1}>{r.value}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionLabel}>{t("account.section")}</Text>
        <View style={styles.card}>
          {actions.map((a, i) => (
            <TouchableOpacity
              key={a.label}
              style={[styles.row, i < actions.length - 1 && styles.rowDivider]}
              onPress={a.onPress}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Ionicons name={a.icon} size={19} color={colors.blue} />
              <Text style={styles.actionLabel}>{a.label}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          ))}
        </View>

        {/* One inline segmented control, not three stacked full-width buttons. */}
        {/* Beside the language picker, by owner instruction — the two are the
            same kind of setting from the driver's side, and this one describes
            the phone's environment rather than the person (see
            lib/outdoorMode). Renders for drivers only. */}
        <OutdoorModeRow style={{ marginTop: 20 }} />
        {/* Opt-in biometric unlock. Renders nothing on a build or device that
            cannot do it, so no platform check is needed here. */}
        <BiometricUnlockRow style={{ marginTop: 20 }} />

        <Text style={styles.sectionLabel}>{t("profile.language")}</Text>
        <View style={styles.segment}>
          {(["en", "ms", "zh"] as const).map((l) => {
            const active = lang === l;
            return (
              <TouchableOpacity
                key={l}
                style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                onPress={() => setLanguage(l)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text
                  style={[styles.segmentText, active && styles.segmentTextActive]}
                  numberOfLines={1}
                >
                  {langLabels[l]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* App & updates — OTA ground truth + manual update pull, for the
            people actually holding phones in the field (28 Jul owner ask). */}
        <AppUpdatesCard style={{ marginTop: 20 }} />

        <Button
          title={t("profile.logout")}
          variant="danger"
          onPress={() => setConfirmLogout(true)}
          style={{ marginTop: 20 }}
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
      <FeedbackModal
        visible={feedbackOpen}
        screen={user?.role === "driver" ? "driver-profile" : "requestor-profile"}
        onClose={() => setFeedbackOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },

  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 22 },
  identityRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.blueDark,
    borderWidth: 2,
    borderColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.yellow, fontSize: 22, fontWeight: "800" },
  name: { color: colors.white, fontSize: 20, fontWeight: "800", lineHeight: 25 },
  subtitle: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginTop: 2 },
  truckRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 },
  plate: { backgroundColor: "#111318", borderWidth: 2, borderColor: "#3a3f4b", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 5 },
  plateText: { color: colors.white, fontSize: 16, fontWeight: "600", letterSpacing: 2 },
  truckMeta: { flex: 1, color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "700" },

  body: { padding: 16, paddingBottom: 32, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rowLabel: { fontSize: 14, color: colors.textMuted },
  rowValue: { marginLeft: "auto", fontSize: 14, fontWeight: "700", color: colors.navy, flexShrink: 1 },
  actionLabel: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.navy },

  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textFaint,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 8,
  },

  segment: {
    flexDirection: "row",
    gap: 4,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    padding: 4,
    ...shadow.card,
  },
  // Three things keep this row one line and one height at every phone width.
  //
  // 1. flexBasis "auto" + flexGrow, NOT flex: 1. Equal thirds starve the longest
  //    label: at 320px a third is ~91px and "Bahasa Malaysia" needs ~95px at
  //    14px/700, so it wrapped in EVERY state on small Androids. Sizing from
  //    content and sharing only the SLACK gives the long label the room it needs
  //    and still fills the row.
  // 2. Fixed height, not minHeight. minHeight is a floor, so a wrapped label
  //    grew its pill and broke the row's alignment instead of being clipped.
  // 3. The selected state changes COLOUR ONLY. It used to bump fontWeight
  //    700 -> 800, which widened the text on selection — at 375px (iPhone SE /
  //    8 / X / 13 mini) "Bahasa Malaysia" fitted unselected and wrapped the
  //    moment you picked it. The blue fill and white text are already an
  //    unmistakable selected affordance; a weight change that reflows the
  //    layout is not worth the extra emphasis.
  segmentBtn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    height: 44,
    paddingHorizontal: 6,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentBtnActive: { backgroundColor: colors.blue },
  segmentText: { fontSize: 14, fontWeight: "700", color: colors.textMuted },
  segmentTextActive: { color: colors.white },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 24, width: "100%" },
  modalTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
});
