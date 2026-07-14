// Admin Settings — the in-app admin's preferences hub. Reached from the PC
// sidebar's "System" group and the phone MORE tab, it renders content only
// (the shell draws the header). Today it holds the language switcher; it is
// structured as a stack of cards so future settings drop in as new sections.
//
// Language switching reuses the SAME mechanism the driver/requestor Profile
// screen uses — useAuth().setLanguage → i18n.changeLanguage (live re-render
// across every screen via react-i18next) + PATCH /users/me (persisted per
// account, re-applied on next login by AuthContext.fetchMe). No parallel i18n.
import React from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { colors, font, radius } from "../theme";
import { Card, SectionTitle } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { AppLanguage } from "../../types";

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

  const current: AppLanguage = (["en", "ms", "zh"] as const).includes(i18n.language as AppLanguage)
    ? (i18n.language as AppLanguage)
    : "en";

  return (
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
  );
}
