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
import {
  exceptionStateLabelKey,
  canDriverAddEvidence,
  isOpenState,
  isClosedOutcome,
  latestOfficeNote,
} from "../lib/exceptionForm";
import { useTripException, useAddExceptionEvidence, useContinueTrip } from "../hooks/useExceptions";
import type { ExceptionFull } from "../services/exceptions";
import { apiErrorMessage } from "../services/api";

// Tone per state. `reported` is deliberately NOT orange: orange is reserved for
// offline/queued (owner ruling, 7 Jul), and a reported exception is neither —
// it reached the office. Amber carries "pending, someone is looking at it",
// the same semantics the fuel nudge and the awaiting-approval chip use.
//
// ⚠ Each state carries its own FOREGROUND. The badge used to paint every tone
// under a single white label, which put `more_evidence` — white on yellow — at
// about 1.4:1. That is the ONE state that asks the driver for something back,
// so it was the least readable badge in the app and the only one that matters
// urgently. Yellow keeps dark text (the same pairing statusColors.pending
// uses, 9.91:1); the rest use the accessible fills.
const STATE_TONE: Record<string, { bg: string; fg: string }> = {
  reported: { bg: colors.amberText, fg: colors.white },
  more_evidence: { bg: colors.yellow, fg: colors.navy },
  verified: { bg: colors.teal, fg: colors.white },
  rejected: { bg: colors.redDeep, fg: colors.white },
  resolved: { bg: colors.greenText, fg: colors.white },
};

/**
 * The driver's view of the exception he just reported (design frames 21 and 22).
 *
 * It answers the only two questions he has while standing there: does the
 * office have this, and is there anything left for me to do. So the card ends
 * in a plain sentence about who holds it — and the ONE state that wants
 * something back from him, `more_evidence`, is the only one with a button.
 *
 * He never sees verify / reject / resume / retry: those are the dispatcher's.
 * The ONE action he gets is "Continue my trip", because an open report blocks
 * every delivery on the trip — without it a report filed at 8pm strands a
 * loaded truck until someone is at a screen. It decides nothing: no
 * resolution, no action, the report stays open for the office.
 */
export function ExceptionStatusCard({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useTripException(tripId);
  const addEvidence = useAddExceptionEvidence();
  const [busy, setBusy] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const continueTrip = useContinueTrip();

  const exc = data as ExceptionFull | null;
  // ⚠ A CLOSED EXCEPTION STILL HAS TO BE TOLD TO HIM. This used to return null
  // the moment the office closed the report, so a REJECTION — terminal, no undo
  // path, and the stop does not pay — reached the driver as a card quietly
  // vanishing, and the first he knew of it was his pay. Open states keep their
  // behaviour; closed ones now render an outcome that persists for the life of
  // the trip.
  if (!exc || !exc.category) return null;
  if (!isOpenState(exc.current_state) && !isClosedOutcome(exc.current_state)) return null;

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

  const onContinue = async () => {
    setContinuing(true);
    try {
      await continueTrip.mutateAsync({
        tripId,
        exId: exc.id,
        input: { clientActionId: uuidv4(), expectedVersion: exc.version },
      });
      toast(t("exception.continueToast"), "success");
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.continueFailed")), "error");
    } finally {
      setContinuing(false);
    }
  };

  const tone = STATE_TONE[exc.current_state] ?? { bg: colors.grey, fg: colors.white };
  const needsEvidence = canDriverAddEvidence(exc.current_state);
  const reportedAt = exc.reported_at ? formatTime(exc.reported_at) : null;
  const officeNote = latestOfficeNote(exc.actions);
  const closed = isClosedOutcome(exc.current_state);

  return (
    <View style={[styles.card, { borderLeftColor: tone.bg }]}>
      <View style={styles.row}>
        <Ionicons name="alert-circle" size={17} color={tone.bg} />
        <Text style={styles.title}>{t("exception.bannerTitle")}</Text>
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <Text style={[styles.badgeText, { color: tone.fg }]}>{t(exceptionStateLabelKey(exc.current_state))}</Text>
        </View>
      </View>

      <Text style={styles.category}>{t(`exception.category.${exc.category}`)}</Text>
      {exc.reason ? <Text style={styles.reason}>{exc.reason}</Text> : null}

      {/* WHAT THE OFFICE SAID. Already on the device in every payload and
          rendered nowhere until now — a dispatcher typing "customer says try
          the side gate" had it delivered and thrown away. */}
      {officeNote ? (
        <View style={styles.officeNote}>
          <View style={styles.officeNoteHead}>
            <Ionicons name="chatbubble-ellipses" size={14} color={colors.blue} />
            <Text style={styles.officeNoteLabel}>{t("exception.officeSays")}</Text>
          </View>
          <Text style={styles.officeNoteText}>{officeNote.note}</Text>
        </View>
      ) : null}

      {closed ? (
        /* THE OUTCOME, and it stays on screen. Rejected carries its pay
           consequence because the engine is unambiguous about it ("a rejected
           stop is ADJUDICATED — it just does not pay") and because a driver who
           is not told here finds out from his payslip. */
        <View style={styles.action}>
          <Text style={styles.outcomeTitle}>
            {t(exc.current_state === "rejected" ? "exception.outcome.rejectedTitle" : "exception.outcome.resolvedTitle")}
          </Text>
          <Text style={styles.prompt}>
            {t(exc.current_state === "rejected" ? "exception.outcome.rejectedBody" : "exception.outcome.resolvedBody")}
          </Text>
          {exc.current_state === "rejected" && !officeNote ? (
            <Text style={styles.prompt}>{t("exception.outcome.noReasonGiven")}</Text>
          ) : null}
        </View>
      ) : needsEvidence ? (
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
          {/* CONTINUE TRIP. Shown only while this report is actually BLOCKING
              him — once he has carried on, the card says so instead of
              offering the button again. `blocking` is derived server-side;
              an older API that omits it is treated as still blocking, which
              is the safe direction (the button 409s harmlessly). */}
          {exc.blocking === false ? (
            <Text style={styles.waiting}>{t("exception.continuedNote")}</Text>
          ) : (
            <View style={styles.action}>
              <Button
                variant="outline"
                title={t("exception.continueTrip")}
                onPress={onContinue}
                loading={continuing}
              />
              <Text style={styles.prompt}>{t("exception.continueHint")}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  officeNote: {
    marginTop: 10,
    backgroundColor: colors.tintBlue,
    borderRadius: radius.sm,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 4,
  },
  officeNoteHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  officeNoteLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: colors.blue,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  officeNoteText: { fontSize: 14, color: colors.navy, lineHeight: 20 },
  outcomeTitle: { fontSize: 15, fontWeight: "800", color: colors.navy },
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
