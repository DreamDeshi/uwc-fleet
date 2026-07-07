import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors } from "../theme";
import { Button } from "./Button";

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.blue} />
      <Text style={styles.muted}>{label ?? t("common.loading")}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <View style={[styles.iconCircle, { backgroundColor: colors.tintRed }]}>
        <Ionicons name="cloud-offline-outline" size={40} color={colors.red} />
      </View>
      <Text style={styles.errorText}>{message ?? t("common.errorGeneric")}</Text>
      {onRetry ? (
        <Button title={t("common.retry")} onPress={onRetry} variant="outline" style={{ marginTop: 16, paddingHorizontal: 28 }} />
      ) : null}
    </View>
  );
}

export function EmptyState({ message, icon = "file-tray-outline" }: { message?: string; icon?: keyof typeof import("@expo/vector-icons").Ionicons.glyphMap }) {
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={40} color={colors.blue} />
      </View>
      <Text style={styles.muted}>{message ?? t("common.noData")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  // The bare gray glyph read as "something broke" even on healthy empty
  // screens — a tinted circle makes both states look deliberate.
  iconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.tintBlue,
    alignItems: "center",
    justifyContent: "center",
  },
  muted: { marginTop: 14, fontSize: 15, color: colors.textMuted, textAlign: "center" },
  errorText: { marginTop: 14, fontSize: 15, color: colors.textMuted, textAlign: "center", lineHeight: 21 },
});
