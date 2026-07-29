import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { capturePodPhoto } from "../lib/photo";
import { uuidv4 } from "../lib/uuid";
import { formatTime } from "../lib/format";
import { exceptionStateLabelKey, canDriverAddEvidence, isOpenState } from "../lib/exceptionForm";
import { useTripException, useAddExceptionEvidence, useSelfResumeException } from "../hooks/useExceptions";
import type { ExceptionFull } from "../services/exceptions";
import { apiErrorMessage } from "../services/api";

// Tone per state. `reported` is deliberately NOT orange: orange is reserved for
// offline/queued (owner ruling, 7 Jul), and a reported exception is neither —
// it reached the office. Amber carries "pending, someone is looking at it",
// the same semantics the fuel nudge and the awaiting-approval chip use.
const STATE_TONE: Record<string, string> = {
  reported: "#d97706",
  more_evidence: colors.yellow,
  verified: colors.teal,
  rejected: colors.red,
  resolved: colors.green,
};

/**
 * The driver's view of the exception he just reported (design frames 21 and 22).
 *
 * It answers the only two questions he has while standing there: does the
 * office have this, and is there anything left for me to do. So the card ends
 * in a plain sentence about who holds it — and the ONE state that wants
 * something back from him, `more_evidence`, is the only one with a button.
 *
 * He never sees verify / reject / retry: those are the dispatcher's. The one
 * action he DOES get is self-resume — "I filed it, I am carrying on" — because
 * an open exception blocks every delivery on the trip, and without it a report
 * filed after hours strands a loaded truck until someone is at a screen.
 */
export function ExceptionStatusCard({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useTripException(tripId);
  const addEvidence = useAddExceptionEvidence();
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const selfResume = useSelfResumeException();

  const exc = data as ExceptionFull | null;
  if (!exc || !exc.category || !isOpenState(exc.current_state)) return null;

  const onAddEvidence = async () => {
    const res = await capturePodPhoto();
    if (res === "permission_denied") {
      toast(t("exception.photoPermissionDenied"), "error");
      return;
    }
    if (!res) return;
    setBusy(true);
    try {
      await addEvidence.mutateAsync({
        tripId,
        exId: exc.id,
        photo: res,
        clientEvidenceId: uuidv4(),
        capturedClientAt: new Date().toISOString(),
      });
      toast(t("exception.evidenceAddedToast"), "success");
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.evidenceFailed")), "error");
    } finally {
      setBusy(false);
    }
  };

  const onSelfResume = async () => {
    setResuming(true);
    try {
      await selfResume.mutateAsync({
        tripId,
        exId: exc.id,
        input: { clientActionId: uuidv4(), expectedVersion: exc.version },
      });
      toast(t("exception.selfResumeToast"), "success");
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.selfResumeFailed")), "error");
    } finally {
      setResuming(false);
    }
  };

  const tone = STATE_TONE[exc.current_state] ?? colors.grey;
  const needsEvidence = canDriverAddEvidence(exc.current_state);
  const reportedAt = exc.reported_at ? formatTime(exc.reported_at) : null;

  return (
    <View style={[styles.card, { borderLeftColor: tone }]}>
      <View style={styles.row}>
        <Ionicons name="alert-circle" size={17} color={tone} />
        <Text style={styles.title}>{t("exception.bannerTitle")}</Text>
        <View style={[styles.badge, { backgroundColor: tone }]}>
          <Text style={styles.badgeText}>{t(exceptionStateLabelKey(exc.current_state))}</Text>
        </View>
      </View>

      <Text style={styles.category}>{t(`exception.category.${exc.category}`)}</Text>
      {exc.reason ? <Text style={styles.reason}>{exc.reason}</Text> : null}

      {needsEvidence ? (
        <View style={styles.action}>
          <Text style={styles.prompt}>{t("exception.moreEvidencePrompt")}</Text>
          <Button title={t("exception.addEvidence")} onPress={onAddEvidence} loading={busy} />
        </View>
      ) : (
        <>
          <Text style={styles.waiting}>
            {reportedAt
              ? t("exception.sentAtWaiting", { time: reportedAt })
              : t("exception.waitingForOffice")}
          </Text>
          {/* SELF-RESUME. An open exception blocks every delivery on the trip,
              so without this the driver sat frozen until an admin was at a
              screen — a report filed at 8pm stranded a loaded truck and every
              remaining consignee until morning. That is the hard blocker on
              turning the feature on.
              It closes the report so he can drive; it decides nothing about
              the stop and nothing about pay (that needs an admin verify, which
              no driver route can create). The stop stays his to deliver. */}
          <View style={styles.action}>
            <Button
              variant="outline"
              title={t("exception.selfResume")}
              onPress={onSelfResume}
              loading={resuming}
            />
            <Text style={styles.prompt}>{t("exception.selfResumeHint")}</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: 14,
    marginBottom: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: "800", color: colors.navy },
  badge: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { color: colors.white, fontSize: 12, fontWeight: "800" },
  category: { fontSize: 13, color: colors.textMuted, fontWeight: "700", marginTop: 8 },
  reason: { fontSize: 14, color: colors.navy, marginTop: 3, lineHeight: 19 },
  action: { marginTop: 12, gap: 8 },
  prompt: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  waiting: { fontSize: 12, color: colors.textMuted, marginTop: 10 },
});
