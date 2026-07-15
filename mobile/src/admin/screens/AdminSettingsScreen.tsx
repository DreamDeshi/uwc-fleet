// Admin Settings — the in-app admin's preferences hub. Reached from the PC
// sidebar's "System" group and the phone MORE tab, it renders content only
// (the shell draws the header). Today it holds the language switcher; it is
// structured as a stack of cards so future settings drop in as new sections.
//
// Language switching reuses the SAME mechanism the driver/requestor Profile
// screen uses — useAuth().setLanguage → i18n.changeLanguage (live re-render
// across every screen via react-i18next) + PATCH /users/me (persisted per
// account, re-applied on next login by AuthContext.fetchMe). No parallel i18n.
import React, { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { colors, font, radius } from "../theme";
import { Card, SectionTitle } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { AppLanguage } from "../../types";
import { EditProfileModal, ChangePasswordModal } from "../../components/AccountModals";

// Language display names are the native endonyms (English / Bahasa Malaysia /
// 简体中文) — identical in every locale — so they reuse the existing
// profile.* keys the driver/requestor picker already ships.
const LANGUAGES: { code: AppLanguage; labelKey: string }[] = [
  { code: "en", labelKey: "profile.english" },
  { code: "ms", labelKey: "profile.malay" },
  { code: "zh", labelKey: "profile.chinese" },
];

export function AdminSettingsScreen() {
  const { t, i18n } = useTranslation();
  const { setLanguage } = useAuth();
  const mode = useLayoutMode();
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const current: AppLanguage = (["en", "ms", "zh"] as const).includes(i18n.language as AppLanguage)
    ? (i18n.language as AppLanguage)
    : "en";

  const accountRows: { key: string; labelKey: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void }[] = [
    { key: "edit", labelKey: "account.editProfile", icon: "create-outline", onPress: () => setEditOpen(true) },
    { key: "password", labelKey: "account.changePassword", icon: "lock-closed-outline", onPress: () => setPwOpen(true) },
  ];

  return (
    <>
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={
        mode === "wide"
          ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 }
          : { padding: 14, gap: 16 }
      }
    >
      {/* Centre the settings column on wide so cards don't stretch across a
          1440px monitor; full-bleed on phones. */}
      <View style={mode === "wide" ? { maxWidth: 680, width: "100%", alignSelf: "center", gap: 16 } : { gap: 16 }}>
        {/* Account — self-service profile + password (any role, incl. admin) */}
        <Card>
          <SectionTitle title={t("account.section")} />
          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", marginTop: 4 }}>
            {accountRows.map((r, i) => (
              <TouchableOpacity
                key={r.key}
                onPress={r.onPress}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingVertical: 15,
                  paddingHorizontal: 16,
                  backgroundColor: colors.card,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: colors.divider,
                }}
              >
                <Ionicons name={r.icon} size={20} color={colors.blue} />
                <Text style={{ flex: 1, fontSize: font.md, fontWeight: "600", color: colors.text }}>
                  {t(r.labelKey)}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        <Card>
          <SectionTitle title={t("admin.settings.languageSection")} />
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: -4, marginBottom: 14, lineHeight: 19 }}>
            {t("admin.settings.languageHint")}
          </Text>

          <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}>
            {LANGUAGES.map((l, i) => {
              const active = current === l.code;
              return (
                <TouchableOpacity
                  key={l.code}
                  onPress={() => setLanguage(l.code)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 15,
                    paddingHorizontal: 16,
                    backgroundColor: active ? colors.blueTint : colors.card,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: colors.divider,
                  }}
                >
                  <Ionicons
                    name={active ? "checkmark-circle" : "ellipse-outline"}
                    size={20}
                    color={active ? colors.blue : colors.textFaint}
                  />
                  <Text style={{ flex: 1, fontSize: font.md, fontWeight: active ? "800" : "600", color: active ? colors.blue : colors.text }}>
                    {t(l.labelKey)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>
      </View>
    </ScrollView>

    <EditProfileModal visible={editOpen} onClose={() => setEditOpen(false)} />
    <ChangePasswordModal visible={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
