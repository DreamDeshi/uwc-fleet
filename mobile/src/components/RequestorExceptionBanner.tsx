import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../theme";
import { useTripException } from "../hooks/useExceptions";
import { toRequestorView } from "../lib/exceptionForm";

/**
 * Requestor-facing REDACTED exception banner on their own booking. Shows ONLY
 * permitted info — state, category, affected stop and time. The server returns a
 * redacted payload to a requestor; `toRequestorView` re-derives only the safe
 * fields as defense-in-depth, so no GPS / evidence / notes / actor ids / internal
 * operational detail is ever rendered.
 */
export function RequestorExceptionBanner({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const { data } = useTripException(tripId);
  const view = toRequestorView(data as Record<string, unknown> | null);
  if (!view || !view.category) return null;

  const tone = view.status === "resolved" ? colors.green : colors.orange;
  return (
    <View style={[styles.card, { borderLeftColor: tone }]}>
      <View style={styles.row}>
        <Text style={styles.title}>{t("exception.requestorTitle")}</Text>
        <View style={[styles.badge, { backgroundColor: tone }]}>
          <Text style={styles.badgeText}>{t(`exception.publicStatus.${view.status}`)}</Text>
        </View>
      </View>
      <Text style={styles.category}>{t(`exception.category.${view.category}`)}</Text>
      {view.stopSequence != null && (
        <Text style={styles.meta}>{t("exception.affectedStop", { n: view.stopSequence })}</Text>
      )}
      {view.reportedAt && (
        <Text style={styles.meta}>{t("exception.reportedAt", { time: new Date(view.reportedAt).toLocaleString() })}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.tintOrange, borderRadius: radius.md, borderLeftWidth: 4, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontWeight: "700", color: colors.text },
  badge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "700" },
  category: { color: colors.text, fontWeight: "600", marginTop: spacing.xs },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
});
