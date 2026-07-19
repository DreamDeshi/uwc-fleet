// Compact global-search entry that lives on the admin dashboard (owner ask,
// 2026-07-19): search used to be its own nav tab; it now sits by the dispatch
// snapshot on the dashboard instead. Tapping opens the existing AdminSearch
// screen (which owns the box + results + result-navigation), shell-aware so it
// resolves on both the PC drawer and the phone tab/stack shells.
import React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { colors, font, radius } from "../theme";
import { useLayoutMode } from "../hooks/useLayoutMode";

export function AdminSearchBar({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const mode = useLayoutMode();

  const open = () => {
    // Wide: AdminSearch is a drawer screen. Narrow: it lives in the MORE
    // stack, reached via the tab (same pattern the MORE list used).
    if (mode === "wide") navigation.navigate("AdminSearch");
    else navigation.navigate("AdminMore", { screen: "AdminSearch" });
  };

  return (
    <Pressable
      onPress={open}
      accessibilityRole="search"
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          paddingVertical: 10,
          paddingHorizontal: 12,
        },
        style,
      ]}
    >
      <Ionicons name="search" size={16} color={colors.textMuted} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: font.md, color: colors.textMuted }}>
        {t("admin.search.placeholder")}
      </Text>
    </Pressable>
  );
}
