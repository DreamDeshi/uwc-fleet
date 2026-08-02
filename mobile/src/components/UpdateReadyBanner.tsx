// "A new version is ready — Restart" — the visible half of the OTA fix.
//
// Until this existed, a downloaded update was completely silent: expo-updates
// fetched it in the background and applied it on some future cold start the
// driver had no reason to perform. The owner's report was that the app "only
// ever updates when you tap Check for updates" — true in effect, because the
// manual button in AppUpdatesCard was the only thing that ever RELOADED.
//
// Bottom-anchored, matching Toast's geometry so the two read as one system.
// Deliberately NOT the top slot: ReconnectingBanner owns that, and the two can
// legitimately be on screen together (download finished, then signal dropped).
//
// ⚠ NOT ORANGE. Owner palette ruling: orange means offline/queued states only.
// A ready update is good news, not a degraded state — blue, like Toast's info.
//
// Not dismissible, by design. A driver who dismisses it is back to the position
// this whole change exists to fix, and the cost of leaving it up is one tap.
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../theme";
import { useOtaUpdate } from "../hooks/useOtaUpdate";

export function UpdateReadyBanner() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { phase, restart } = useOtaUpdate();

  // Only "ready" is worth screen space. A check or download in flight is not
  // the driver's business, and a failed one is not something they can act on.
  if (phase !== "ready") return null;

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 24 }]} pointerEvents="box-none">
      <View style={styles.bar}>
        <Ionicons name="cloud-download-outline" size={20} color={colors.blue} />
        <Text style={styles.text}>{t("common.updateReady")}</Text>
        <Pressable
          onPress={restart}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel={t("common.updateRestart")}
        >
          <Text style={styles.actionText}>{t("common.updateRestart")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderLeftWidth: 5,
    borderLeftColor: colors.blue,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 10,
    maxWidth: 460,
    ...shadow.floating,
  },
  text: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.navy },
  action: {
    backgroundColor: colors.blue,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actionText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
