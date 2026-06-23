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
      <Ionicons name="cloud-offline-outline" size={48} color={colors.textFaint} />
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
      <Ionicons name={icon} size={48} color={colors.textFaint} />
      <Text style={styles.muted}>{message ?? t("common.noData")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  muted: { marginTop: 12, fontSize: 14, color: colors.textMuted, textAlign: "center" },
  errorText: { marginTop: 12, fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
});
