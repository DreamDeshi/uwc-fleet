// Charts shim — replaced in Phase 4 by the victory-native / web platform
// split the requestor Analytics screen already uses (the web admin's
// Recharts does not exist in RN). Until then Reports renders this box.
import React from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";

export function AdminChart(_props: { height?: number }) {
  const { t } = useTranslation();
  return (
    <View
      style={{
        height: _props.height ?? 250,
        borderRadius: radius.lg,
        backgroundColor: colors.panel,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: font.md, color: colors.textMuted }}>{t("admin.comingSoon")}</Text>
    </View>
  );
}
