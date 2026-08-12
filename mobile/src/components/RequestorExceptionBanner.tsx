import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../theme";
import { useTripException } from "../hooks/useExceptions";
import { requestorReasonLabelKey, toRequestorView } from "../lib/exceptionForm";

/**
 * Requestor-facing REDACTED exception banner on their own booking. Shows ONLY
 * permitted info — the reason, coarse status, affected stop and time. The server
 * returns a redacted payload to a requestor; `toRequestorView` re-derives only
 * the safe fields as defense-in-depth, so no GPS / evidence / notes / actor ids /
 * internal operational detail is ever rendered.
 *
 * C9 (Mr. Teh, 11 Aug 2026, "OPTION B"): the requestor sees the REASON, never
 * the pay decision. Nothing on this card is money, and nothing that reaches it
 * can be: the redacted contract carries no incentive field at all.
 */
export function RequestorExceptionBanner({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const { data } = useTripException(tripId);
  const view = toRequestorView(data as Record<string, unknown> | null);
  if (!view || !view.category) return null;

  // AMBER, not orange: orange is reserved for offline/queued states, and amber
  // is the palette's owner-approved "pending, someone is looking at it" hue.
  // Both tones are the ACCESSIBLE variants — the badge puts white text on this
  // fill, and `green`/`amber` proper are decorative (white on `green` is
  // 3.00:1, the defect the 4 Aug sweep fixed everywhere else).
  const resolved = view.status === "resolved";
  const tone = resolved ? colors.greenText : colors.amberText;
  const surface = resolved ? colors.tintGreen : colors.tintYellow;
  const reasonKey = requestorReasonLabelKey(view.category);
  return (
    <View style={[styles.card, { backgroundColor: surface, borderLeftColor: tone }]}>
      <View style={styles.row}>
        <Text style={styles.title}>{t("exception.requestorTitle")}</Text>
        <View style={[styles.badge, { backgroundColor: tone }]}>
          <Text style={styles.badgeText}>{t(`exception.publicStatus.${view.status}`)}</Text>
        </View>
      </View>
      {reasonKey && <Text style={styles.category}>{t(reasonKey)}</Text>}
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
  card: { borderRadius: radius.md, borderLeftWidth: 4, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontWeight: "700", color: colors.text },
  badge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "700" },
  category: { color: colors.text, fontWeight: "600", marginTop: spacing.xs },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
});
