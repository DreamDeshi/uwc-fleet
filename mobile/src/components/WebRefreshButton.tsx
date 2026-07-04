import React from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";

// react-native-web's RefreshControl renders a plain View — the pull-to-refresh
// gesture simply doesn't exist in a browser, and browser drivers are the
// trial's primary platform (audit 2026-07-05 #7). This small tappable pill is
// the web-only stand-in: same refetch handle, rendered nowhere on native
// (where the real pull gesture works).
export function WebRefreshButton({
  refreshing,
  onRefresh,
  style,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  style?: object;
}) {
  const { t } = useTranslation();
  if (Platform.OS !== "web") return null;
  return (
    <TouchableOpacity
      onPress={onRefresh}
      disabled={refreshing}
      style={[styles.btn, refreshing && { opacity: 0.6 }, style]}
      activeOpacity={0.7}
      hitSlop={8}
    >
      {refreshing ? (
        <ActivityIndicator size={14} color={colors.blue} />
      ) : (
        <Ionicons name="refresh" size={14} color={colors.blue} />
      )}
      <Text style={styles.text}>
        {refreshing ? t("common.refreshing") : t("common.refresh")}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.blue,
    backgroundColor: colors.tintBlue,
  },
  text: { fontSize: 12, fontWeight: "700", color: colors.blue },
});
