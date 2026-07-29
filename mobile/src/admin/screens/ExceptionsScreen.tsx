import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Image, RefreshControl } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../../theme";
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { useOpenExceptions, useTripException, useAdminExceptionAction } from "../../hooks/useExceptions";
import { exceptionStateLabelKey } from "../../lib/exceptionForm";
import { uuidv4 } from "../../lib/uuid";
import { apiErrorCode, apiErrorMessage } from "../../services/api";
import type { ExceptionFull, ExceptionListRow } from "../../services/exceptions";

const CONFLICT_CODES = ["VERSION_CONFLICT", "EXCEPTION_STATE_CHANGED", "IDEMPOTENCY_KEY_REUSED", "POINTER_INCONSISTENT"];

/** Admin Exceptions lane — the list of OPEN exceptions + a detail with the
 *  Phase-1 actions (verify / request more evidence / reject / resume / retry).
 *  Reschedule / reassignment / return-cargo / cancel are intentionally absent. */
export function ExceptionsScreen() {
  const { t } = useTranslation();
  const list = useOpenExceptions();
  const [selected, setSelected] = useState<ExceptionListRow | null>(null);

  if (list.isLoading) return <LoadingState />;
  if (list.isError) return <ErrorState onRetry={list.refetch} />;
  const rows = list.data ?? [];

  return (
    <View style={styles.fill}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={list.refetch} />}
      >
        {rows.length === 0 ? (
          <EmptyState message={t("exception.noneOpen")} />
        ) : (
          rows.map((r) => (
            <TouchableOpacity key={r.id} style={styles.rowCard} onPress={() => setSelected(r)}>
              <View style={styles.rowTop}>
                <Text style={styles.ticket}>{r.ticket_number}</Text>
                <View style={styles.badge}><Text style={styles.badgeText}>{t(exceptionStateLabelKey(r.current_state))}</Text></View>
              </View>
              <Text style={styles.cat}>{t(`exception.category.${r.category}`)}</Text>
              <Text style={styles.meta}>{[r.driver_name, r.truck_plate].filter(Boolean).join(" · ")}</Text>
              {r.stop && <Text style={styles.meta}>{t("exception.affectedStop", { n: r.stop.sequence })} — {r.stop.company_name}</Text>}
              <Text style={styles.reason} numberOfLines={2}>{r.reason}</Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      {selected && (
        <ExceptionDetailModal
          row={selected}
          onClose={() => setSelected(null)}
          onResolved={() => { setSelected(null); list.refetch(); }}
        />
      )}
    </View>
  );
}

function ExceptionDetailModal({ row, onClose, onResolved }: { row: ExceptionListRow; onClose: () => void; onResolved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const detail = useTripException(row.trip_id);
  const action = useAdminExceptionAction();
  const [note, setNote] = useState("");

  const exc = detail.data as ExceptionFull | null;
  // Has an admin already made the PAY decision on this report? Mirrors the
  // server rule in api/src/services/undeliveredPay.ts — a `verify` action in
  // the append-only log is half of what pays the stop; closing with "Do not
  // return" (resume) is the other half. Keep the two in step.
  const isVerified = (exc?.actions ?? []).some((a) => a.type === "verify");
  // ...but a verify can only ever pay a stop the driver actually REACHED
  // (Q11(b): "if the lorry breakdown halfway, no incentive"), and a trip-level
  // report has no stop at all. Saying "pay approved" for one of those would be
  // a false promise on the one screen whose whole job is to state the money
  // consequence — a `truck` report filed en route attaches to the NEXT stop,
  // which has no arrival.
  const canPay = Boolean(row.stop?.arrived_at);
  const paysThisStop = isVerified && canPay;

  const run = async (kind: "verify" | "request-more-evidence" | "reject" | "resume" | "resolve") => {
    if (!exc) return;
    if ((kind === "reject" || kind === "request-more-evidence") && note.trim().length === 0) {
      toast(t("exception.noteRequired"), "error");
      return;
    }
    try {
      await action.mutateAsync({
        tripId: row.trip_id,
        exId: exc.id,
        action: kind,
        resolution: kind === "resolve" ? "retry" : undefined,
        input: { clientActionId: uuidv4(), note: note.trim() || undefined, expectedVersion: exc.version },
      });
      toast(t("exception.actionDone"), "success");
      if (kind === "reject" || kind === "resume" || kind === "resolve") onResolved();
      else { setNote(""); detail.refetch(); }
    } catch (e) {
      if (CONFLICT_CODES.includes(apiErrorCode(e) ?? "")) {
        // Version/state/idempotency conflict — refresh to server truth and tell the admin.
        detail.refetch();
        toast(t("exception.conflictRefreshed"), "error");
      } else {
        toast(apiErrorMessage(e, t("exception.actionFailed")), "error");
      }
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.modalCard}>
          <View style={styles.rowTop}>
            <Text style={styles.title}>{row.ticket_number}</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.close}>✕</Text></TouchableOpacity>
          </View>
          {detail.isLoading || !exc ? (
            <LoadingState />
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.cat}>{t(`exception.category.${exc.category}`)} · {t(exceptionStateLabelKey(exc.current_state))}</Text>
              <Text style={styles.reason}>{exc.reason}</Text>

              <Text style={styles.section}>{t("exception.evidenceLabel")}</Text>
              <ScrollView horizontal>
                {exc.evidence.map((e) => <Image key={e.id} source={{ uri: e.url }} style={styles.evidence} />)}
              </ScrollView>

              <Text style={styles.section}>{t("exception.timelineLabel")}</Text>
              {exc.actions.map((a) => (
                <View key={a.id} style={styles.timelineRow}>
                  <Text style={styles.timelineType}>{t(`exception.action.${a.type}`)}{a.resolution ? ` (${a.resolution})` : ""}</Text>
                  <Text style={styles.timelineMeta}>{new Date(a.created_at).toLocaleString()}{a.note ? ` — ${a.note}` : ""}</Text>
                </View>
              ))}

              <Text style={styles.section}>{t("exception.noteLabel")}</Text>
              <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder={t("exception.notePlaceholder")} multiline />

              {/* THE PAY BANNER. Since R3 Q11(a) a failed stop can be paid the
                  same as a delivered one, and the two halves of that decision
                  are Verify (approve the pay) + "Do not return" (close it).
                  Neither is obvious from a bare verb, and an admin who taps
                  the wrong one moves real money — so the current pay state is
                  stated outright rather than left to be inferred. */}
              <View style={[styles.payBanner, paysThisStop ? styles.payBannerOn : styles.payBannerOff]}>
                <Text style={styles.payBannerTitle}>
                  {paysThisStop
                    ? t("exception.pay.approvedTitle")
                    : canPay
                      ? t("exception.pay.notApprovedTitle")
                      : t("exception.pay.noStopTitle")}
                </Text>
                <Text style={styles.payBannerBody}>
                  {paysThisStop
                    ? t("exception.pay.approvedBody")
                    : canPay
                      ? t("exception.pay.notApprovedBody")
                      : t("exception.pay.noStopBody")}
                </Text>
              </View>

              <View style={styles.actions}>
                {/* Step 1 — the pay decision. */}
                <Text style={styles.actionGroup}>{t("exception.group.decide")}</Text>
                <Button variant="success" title={t("exception.verify")} onPress={() => run("verify")} />
                <Text style={styles.actionHint}>{t("exception.verifyHint")}</Text>
                <Button variant="danger" title={t("exception.reject")} onPress={() => run("reject")} />
                <Text style={styles.actionHint}>{t("exception.rejectHint")}</Text>
                <Button variant="outline" title={t("exception.requestMore")} onPress={() => run("request-more-evidence")} />

                {/* Step 2 — what the truck does next. Only "resume" closes the
                    stop; "retry" deliberately settles nothing so the driver can
                    still deliver it. */}
                <Text style={styles.actionGroup}>{t("exception.group.next")}</Text>
                <Button title={t("exception.resume")} onPress={() => run("resume")} />
                <Text style={styles.actionHint}>
                  {paysThisStop ? t("exception.resumeHintVerified") : t("exception.resumeHintUnverified")}
                </Text>
                <Button variant="outline" title={t("exception.retry")} onPress={() => run("resolve")} />
                <Text style={styles.actionHint}>{t("exception.retryHint")}</Text>
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  rowCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: spacing.md, ...{} },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ticket: { fontWeight: "700", color: colors.text },
  badge: { backgroundColor: colors.orange, paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { color: colors.white, fontSize: 11, fontWeight: "700" },
  cat: { color: colors.text, fontWeight: "600", marginTop: spacing.xs },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  reason: { color: colors.textMuted, marginTop: spacing.xs },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, maxHeight: "90%" },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  close: { fontSize: 20, color: colors.textMuted, paddingHorizontal: spacing.sm },
  section: { fontWeight: "700", color: colors.text, marginTop: spacing.lg, marginBottom: spacing.xs },
  evidence: { width: 120, height: 120, borderRadius: radius.md, marginRight: spacing.sm },
  timelineRow: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  timelineType: { fontWeight: "600", color: colors.text },
  timelineMeta: { color: colors.textMuted, fontSize: 12 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 60, textAlignVertical: "top", color: colors.text },
  actions: { gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.xl },
  actionGroup: { fontWeight: "700", color: colors.text, marginTop: spacing.md, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 },
  actionHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: -spacing.xs, marginBottom: spacing.xs },
  payBanner: { borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, borderLeftWidth: 4 },
  // Same tints the admin design system already uses: #F0FDF4 green (see
  // SustainabilityScreen) and #FFF7E0 amber (see the alerts banner).
  payBannerOn: { backgroundColor: "#F0FDF4", borderLeftColor: colors.green },
  payBannerOff: { backgroundColor: "#FFF7E0", borderLeftColor: colors.yellow },
  payBannerTitle: { fontWeight: "700", color: colors.text, marginBottom: 2 },
  payBannerBody: { color: colors.text, fontSize: 12, lineHeight: 17 },
});
