import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../theme";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { capturePodPhoto } from "../lib/photo";
import { uuidv4 } from "../lib/uuid";
import { exceptionStateLabelKey, canDriverAddEvidence, isOpenState } from "../lib/exceptionForm";
import { useTripException, useAddExceptionEvidence } from "../hooks/useExceptions";
import type { ExceptionFull } from "../services/exceptions";
import { apiErrorMessage } from "../services/api";

const STATE_TONE: Record<string, string> = {
  reported: colors.orange,
  more_evidence: colors.yellow,
  verified: colors.teal,
  rejected: colors.red,
  resolved: colors.green,
};

/**
 * Driver-facing current-exception card: shows the state + category + reason, and
 * — only when the admin has requested more evidence — an "Add evidence" button.
 * The driver never sees verify/reject/resume/retry controls.
 */
export function ExceptionStatusCard({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useTripException(tripId);
  const addEvidence = useAddExceptionEvidence();
  const [busy, setBusy] = useState(false);

  const exc = data as ExceptionFull | null;
  if (!exc || !exc.category || !isOpenState(exc.current_state)) return null;

  const onAddEvidence = async () => {
    const res = await capturePodPhoto();
    if (res === "permission_denied") { toast(t("exception.photoPermissionDenied"), "error"); return; }
    if (!res) return;
    setBusy(true);
    try {
      await addEvidence.mutateAsync({ tripId, exId: exc.id, photo: res, clientEvidenceId: uuidv4(), capturedClientAt: new Date().toISOString() });
      toast(t("exception.evidenceAddedToast"), "success");
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.evidenceFailed")), "error");
    } finally {
      setBusy(false);
    }
  };

  const tone = STATE_TONE[exc.current_state] ?? colors.grey;
  return (
    <View style={[styles.card, { borderLeftColor: tone }]}>
      <View style={styles.row}>
        <Text style={styles.title}>{t("exception.bannerTitle")}</Text>
        <View style={[styles.badge, { backgroundColor: tone }]}>
          <Text style={styles.badgeText}>{t(exceptionStateLabelKey(exc.current_state))}</Text>
        </View>
      </View>
      <Text style={styles.category}>{t(`exception.category.${exc.category}`)}</Text>
      <Text style={styles.reason}>{exc.reason}</Text>
      {canDriverAddEvidence(exc.current_state) && (
        <View style={styles.action}>
          <Text style={styles.prompt}>{t("exception.moreEvidencePrompt")}</Text>
          <Button title={t("exception.addEvidence")} onPress={onAddEvidence} loading={busy} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: radius.md, borderLeftWidth: 4, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontWeight: "700", color: colors.text },
  badge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "700" },
  category: { color: colors.text, fontWeight: "600", marginTop: spacing.xs },
  reason: { color: colors.textMuted, marginTop: 2 },
  action: { marginTop: spacing.md, gap: spacing.xs },
  prompt: { color: colors.textMuted, fontSize: 13 },
});
