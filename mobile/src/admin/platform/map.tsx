// Fleet-map shim — replaced in Phase 3 by the real map (react-native-maps on
// native, the web fallback split the driver/requestor maps already use; the
// web admin's Leaflet map does not exist in RN). Zone data comes from
// ../lib/zones.ts either way. Until then the dashboard renders this box.
import React from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";

export function AdminFleetMap(_props: { height?: number }) {
  const { t } = useTranslation();
  return (
    <View
      style={{
        height: _props.height ?? 320,
        borderRadius: radius.lg,
        backgroundColor: colors.blueTint,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: font.md, color: colors.textMuted }}>{t("admin.comingSoon")}</Text>
    </View>
  );
}
