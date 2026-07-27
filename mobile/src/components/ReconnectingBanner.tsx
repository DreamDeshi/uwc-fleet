// Slim top banner shown while the session runs on the CACHED identity
// (cold-start fetch failed; AuthContext's self-heal is retrying every 20 s
// and on each foreground). Before this, the degraded state was invisible —
// screens just errored with no explanation. Orange per the owner's palette
// ruling: orange = offline/queued states only.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { colors } from "../theme";

export function ReconnectingBanner() {
  const { t } = useTranslation();
  const { degraded } = useAuth();
  const insets = useSafeAreaInsets();
  if (!degraded) return null;
  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]} pointerEvents="none">
      <View style={styles.bar}>
        <Ionicons name="cloud-offline-outline" size={13} color="#fff" />
        <Text style={styles.text}>{t("common.reconnecting")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 999, alignItems: "center" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.orange,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  text: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
