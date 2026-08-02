// POD incentive-approval queue (Mr. Teh, 16 Jul 2026 — TEST QUERY item 9):
// "After driver complete the delivery, they will have to upload the proof of
// delivery (chop-sign return copy on DO), then together with the incentive
// rate, submit to admin for approval; admin also can edit the final rate prior
// approval."
//
// A delivered trip sits in `pending_approval` with its incentive PROPOSED
// (frozen at delivery under that day's ledger + snapshot rates) but NOT paid.
// The admin reviews the POD photo + proposed amount and either approves it
// as-is or edits the final amount (an edit REQUIRES a reason; the original
// proposal is preserved). Approving flips the trip to `completed` and sets the
// payable `incentive_final` — the moment the money counts toward payroll.
//
// Design language mirrors ApprovalsScreen (the user queue): summary count card
// + per-item cards, inline actions on wide, full-width on narrow. Strings via
// t() (admin.incentiveApprovals.*).
import React, { useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApproveIncentive, usePendingApprovals } from "../hooks/queries";
import { colors, font, radius } from "../theme";

import { Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Pill } from "../components/ui";
import { formatMoney, formatDateTime, formatTime } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { Trip, TripStop } from "../types";
import { isStopSettled } from "../../lib/stopSettled";
import { k2ApprovalGaps, k2Evidence, type K2ApprovalGaps } from "../lib/k2Evidence";

/** What an approval sends beyond the trip id. `{}` = pay the proposal as-is. */
type ApprovalVars = { final_amount?: number; reason?: string };

// The engine proposal stored on the trip (what pay defaults to at approval).
const proposedAmount = (trip: Trip): number => Number(trip.incentive_earned ?? 0);

/** A POD whose DEVICE capture time is meaningfully earlier than the server's
 *  receipt — i.e. it was queued offline and replayed. Only then is showing both
 *  worth the row space; online the two are seconds apart. */
const OFFLINE_GAP_MS = 2 * 60 * 1000;
function podCapturedApart(stop: TripStop): boolean {
  if (!stop.pod_captured_client_at || !stop.pod_uploaded_at) return false;
  const gap = new Date(stop.pod_uploaded_at).getTime() - new Date(stop.pod_captured_client_at).getTime();
  return Number.isFinite(gap) && gap >= OFFLINE_GAP_MS;
}

// The trip's first EARNING instant — the anchor finalization actually scored
// against, and the instant the trip flipped to pending_approval. Mirrors the
// server's firstEarningInstant: since R3 Q11(a) a stop can be PAID without a
// delivery confirm (reached, admin verified + resumed), so a delivered-only
// version showed a blank date on an all-failed trip and sorted it to the top of
// the approvals queue as if it were the oldest.
function deliveredAt(trip: Trip): string | null {
  return trip.stops.reduce<string | null>((earliest, s) => {
    const at = s.delivered_at ?? (isStopSettled(s) ? s.arrived_at : null);
    return at && (!earliest || at < earliest) ? at : earliest;
  }, null);
}

export function IncentiveApprovalsScreen() {
  const { t } = useTranslation();
  const pending = usePendingApprovals();
  const mode = useLayoutMode();

  if (pending.isLoading) return <Loading />;
  if (pending.isError)
    return <ErrorState message={t("admin.incentiveApprovals.loadError")} onRetry={() => pending.refetch()} />;

  const trips = [...(pending.data ?? [])].sort(
    // Oldest delivery first — the driver who's been waiting longest is paid first.
    (a, b) => (deliveredAt(a) ?? "").localeCompare(deliveredAt(b) ?? "")
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={
        mode === "wide"
          ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 }
          : { padding: 14, gap: 16 }
      }
      refreshControl={<RefreshControl refreshing={pending.isRefetching} onRefresh={() => pending.refetch()} />}
    >
      <Card
        pad={14}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 12 },
          trips.length > 0 && { borderLeftWidth: 5, borderLeftColor: colors.orange },
        ]}
      >
        {trips.length > 0 && (
          <View style={{ backgroundColor: colors.orangeTint, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 11 }}>
            <Text style={{ color: colors.orange, fontSize: font.sm, fontWeight: "800" }}>{trips.length}</Text>
          </View>
        )}
        <Text style={{ fontSize: font.md, color: colors.text, flex: 1 }}>
          {trips.length === 0
            ? t("admin.incentiveApprovals.noneWaiting")
            : t("admin.incentiveApprovals.awaiting", { count: trips.length })}
        </Text>
      </Card>

      {trips.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.incentiveApprovals.queueEmpty")} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {trips.map((trip) => (
            <ApprovalCard key={trip.id} trip={trip} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function ApprovalCard({ trip }: { trip: Trip }) {
  const { t } = useTranslation();
  const approve = useApproveIncentive();
  const mode = useLayoutMode();
  const wide = mode === "wide";

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Pending approval held back by the K2 gate. `{}` is a plain approve-as-is;
  // an object with final_amount is an edited one. null = nothing held.
  const [confirmK2, setConfirmK2] = useState<ApprovalVars | null>(null);

  const proposed = proposedAmount(trip);
  const delivered = deliveredAt(trip);

  const stops = [...trip.stops].sort((a, b) => a.sequence - b.sequence);
  const k2Gaps = k2ApprovalGaps(stops);

  async function runApproval(vars: ApprovalVars) {
    setError(null);
    try {
      // No final_amount → the server pays the proposal exactly.
      await approve.mutateAsync({ id: trip.id, ...vars });
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentiveApprovals.actionFailed")));
    }
  }

  /**
   * EVERY path that releases pay goes through here (owner ruling, 2 Aug 2026).
   *
   * ⚠ Gating only the Approve button would leave "Edit rate → approve" as a
   * one-click bypass of the confirm — the edit path is an approval too, and it
   * is the path an admin takes when something already looks off.
   */
  function guardedApprove(vars: ApprovalVars) {
    if (k2Gaps.blocking.length > 0) {
      // RN Modals do not stack, so the edit dialog must close before the gate
      // opens. The amount and reason ride along on `confirmK2`.
      setEditing(false);
      setConfirmK2(vars);
      return;
    }
    void runApproval(vars);
  }

  const actions = (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button
        variant="outline"
        size="sm"
        disabled={approve.isPending}
        onPress={() => setEditing(true)}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("admin.incentiveApprovals.editRate")}
      </Button>
      <Button
        variant="success"
        size="sm"
        disabled={approve.isPending}
        onPress={() => guardedApprove({})}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("admin.incentiveApprovals.approve")}
      </Button>
    </View>
  );

  return (
    <Card style={{ borderLeftWidth: 5, borderLeftColor: colors.orange, gap: 12 }}>
      {/* Heading: ticket + driver + delivered time */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: "800", color: colors.text }}>
            {trip.ticket_number}
          </Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
            {trip.driver?.name ?? t("admin.incentiveApprovals.noDriver")}
            {trip.truck_plate ? ` · ${trip.truck_plate}` : ""}
          </Text>
          {delivered ? (
            <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 2 }}>
              {t("admin.incentiveApprovals.deliveredAt", { at: formatDateTime(delivered) })}
            </Text>
          ) : null}
          {/* Partial abort (28 Jul rule): undelivered stops are NOT missing
              evidence — the trip was cut short and only the delivered stops
              are being paid. Without this chip a partial trip is
              indistinguishable from one with missing PODs. */}
          {(() => {
            const done = stops.filter((s) => s.status === "delivered").length;
            if (done >= stops.length) return null;
            return (
              <View style={{ alignSelf: "flex-start", marginTop: 4 }}>
                <Pill bg={colors.yellowTint} fg={colors.amber}>
                  {t("admin.incentiveApprovals.partialTrip", { done, total: stops.length })}
                </Pill>
              </View>
            );
          })()}
        </View>
        {/* Proposed incentive — the amount pay defaults to. */}
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontSize: font.xs, color: colors.textMuted }}>
            {t("admin.incentiveApprovals.proposed")}
          </Text>
          <Text style={{ fontSize: 22, fontWeight: "900", color: colors.green }}>
            {formatMoney(proposed)}
          </Text>
        </View>
      </View>

      {/* Stops + POD photo links (the evidence the admin approves against) */}
      <View style={{ gap: 6 }}>
        {stops.map((s) => (
          <StopRow key={s.id} stop={s} />
        ))}
      </View>

      {error ? <Text style={{ fontSize: font.sm, color: colors.red }}>{error}</Text> : null}

      {actions}

      {editing && (
        <EditRateModal
          trip={trip}
          proposed={proposed}
          pending={approve.isPending}
          onClose={() => setEditing(false)}
          onSubmit={async (finalAmount, reason) => {
            setError(null);
            if (k2Gaps.blocking.length > 0) {
              // Hand off to the K2 gate rather than approving. Closing this
              // dialog first is required, not cosmetic: RN Modals do not stack.
              guardedApprove({ final_amount: finalAmount, reason });
              return;
            }
            try {
              await approve.mutateAsync({ id: trip.id, final_amount: finalAmount, reason });
              setEditing(false);
            } catch (e) {
              // Surface on the modal via a thrown error the modal catches.
              throw e;
            }
          }}
        />
      )}

      {confirmK2 && (
        <K2ApprovalGate
          gaps={k2Gaps}
          pending={approve.isPending}
          onCancel={() => setConfirmK2(null)}
          onConfirm={() => {
            const vars = confirmK2;
            setConfirmK2(null);
            void runApproval(vars);
          }}
        />
      )}
    </Card>
  );
}

/**
 * The missing-K2 approval gate (owner ruling, 2 Aug 2026).
 *
 * ⚠ THE WHOLE POINT IS THAT IT NAMES WHICH STOPS AND WHY. "K2 missing" alone
 * would be read as the ordinary partial-trip noise this screen is full of, and
 * waved through. A delivered stop with no customs document is a different
 * animal: the upload gate stands directly in front of the Delivered tap, so
 * this combination should be impossible, and the admin is about to release pay
 * on it anyway.
 */
function K2ApprovalGate({
  gaps,
  pending,
  onCancel,
  onConfirm,
}: {
  gaps: K2ApprovalGaps<TripStop>;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onCancel} title={t("admin.incentiveApprovals.k2GateTitle")} width={460}>
      <Text style={{ fontSize: font.sm, color: colors.text, lineHeight: 20, marginBottom: 10 }}>
        {t("admin.incentiveApprovals.k2GateBody")}
      </Text>
      <View
        style={{
          backgroundColor: colors.orangeTint,
          borderRadius: radius.sm,
          paddingVertical: 8,
          paddingHorizontal: 12,
          gap: 4,
          marginBottom: 12,
        }}
      >
        {gaps.blocking.map((s) => (
          <Text key={s.id} style={{ fontSize: font.sm, fontWeight: "700", color: colors.orange }}>
            {s.sequence}. {s.consignee.company_name}
          </Text>
        ))}
      </View>
      {/* Shown ONLY when the trip actually contains one, so it explains a
          contrast the admin can see on screen rather than describing a case
          that isn't there. Without it, a trip with both kinds of stop leaves
          them guessing which ones the warning covers. */}
      {gaps.notExpected.length > 0 ? (
        <Text style={{ fontSize: font.sm, color: colors.textMuted, lineHeight: 20, marginBottom: 12 }}>
          {t("admin.incentiveApprovals.k2GateNotExpected", {
            stops: gaps.notExpected.map((s) => `${s.sequence}. ${s.consignee.company_name}`).join(", "),
          })}
        </Text>
      ) : null}
      <Text style={{ fontSize: font.sm, color: colors.text, lineHeight: 20, marginBottom: 14 }}>
        {t("admin.incentiveApprovals.k2GateWarn")}
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button variant="ghost" onPress={onCancel} disabled={pending} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="success" onPress={onConfirm} disabled={pending} style={{ flex: 1 }}>
          {pending ? t("admin.working") : t("admin.incentiveApprovals.k2GateApproveAnyway")}
        </Button>
      </View>
    </Modal>
  );
}

function StopRow({ stop }: { stop: TripStop }) {
  const { t } = useTranslation();
  // ⚠ ORDER AND LABELS ARE LOAD-BEARING ON THIS SCREEN. The admin can override
  // the paid amount here, and the rate tier keys on the DELIVERY CONFIRM (3 Jul
  // 2026; refined by R1 Q4). The POD upload necessarily PRECEDES the delivered
  // tap — delivery is gated on pod_photo — so an upload at 17:58 can belong to a
  // delivery at 18:03 that correctly rated OFF-PEAK. Showing the upload time as
  // the only per-drop time, unlabelled, invited exactly the wrong correction:
  // a 7-point drop "fixed" from RM91 to RM77. So the POD time says "uploaded",
  // and the delivery confirm sits beside it as the instant that actually paid.
  const evidenceParts = [
    stop.points_awarded != null ? t("admin.incentiveApprovals.dropPoints", { pts: stop.points_awarded }) : null,
    stop.points_awarded != null && stop.was_repeat ? t("admin.incentiveApprovals.repeat") : null,
    stop.points_awarded != null && stop.zone_code ? stop.zone_code : null,
    stop.delivered_at ? t("admin.incentiveApprovals.stopDelivered", { time: formatTime(stop.delivered_at) }) : null,
    stop.pod_uploaded_at ? t("admin.incentiveApprovals.podTime", { time: formatTime(stop.pod_uploaded_at) }) : null,
    // Device capture time, shown ONLY when it materially differs from the
    // upload — i.e. the POD was queued offline and replayed later. Online the
    // gap is seconds and repeating it would just be noise. Labelled "(device)"
    // because it is client-supplied and therefore weaker evidence than the
    // server's own receipt beside it.
    podCapturedApart(stop)
      ? t("admin.incentiveApprovals.podTaken", { time: formatTime(stop.pod_captured_client_at!) })
      : null,
  ].filter((p): p is string => Boolean(p));
  const k2 = k2Evidence(stop);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 10,
        backgroundColor: colors.panel,
        borderRadius: radius.sm,
      }}
    >
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#fff", fontSize: font.xs, fontWeight: "700" }}>{stop.sequence}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: font.md, color: colors.text }}>
          {stop.consignee.company_name}
        </Text>
        {/* Per-drop pay evidence: points + repeat flag, so the admin sees WHY
            the proposal is what it is before approving. Null on pre-feature trips.
            The POD time (IM6) rides the same line — it is the evidence a
            contested approval is argued over, and it was previously stored
            nowhere. Absent on any POD that predates the column; shown only when
            genuinely known, never substituted from delivered_at. */}
        {evidenceParts.length > 0 ? (
          <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 1 }}>
            {evidenceParts.join(" · ")}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {stop.pod_photo ? (
          <Pressable onPress={() => Linking.openURL(stop.pod_photo!)}>
            <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>📷 POD ↗</Text>
          </Pressable>
        ) : stop.status !== "delivered" ? (
          // Cut short by a partial abort — not paid, not missing evidence. Muted
          // on purpose: orange "no POD" would read as a problem to chase.
          <Pill bg={colors.panel} fg={colors.textMuted}>
            {t("admin.incentiveApprovals.notDelivered")}
          </Pill>
        ) : (
          <Pill bg={colors.orangeTint} fg={colors.orange}>
            {t("admin.incentiveApprovals.noPod")}
          </Pill>
        )}
        {/* The Borang K2 (IM9). Until this row existed, NOTHING in the admin app
            rendered k2_photo — the document that gates Delivered, and therefore
            pay, was one nobody had ever seen. Mr. Teh R1 Q6: "we need admin to
            final validate and approve, only they can get pay."

            ⚠ AN OPEN ACTION, NEVER AN INLINE <Image>. A K2 may be a multi-page
            PDF and the signed URL carries no extension to tell us which (see
            admin/types.ts). Rendering it as an image would show a blank box for
            every PDF — and a page-1 raster preview would be WORSE: it looks
            complete while hiding pages, which is exactly the silent truncation
            signedK2Url refuses to risk. Hand it to the system viewer whole. */}
        {k2 === "present" ? (
          <Pressable onPress={() => Linking.openURL(stop.k2_photo!)}>
            <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>📄 K2 ↗</Text>
          </Pressable>
        ) : k2 === "missing" && stop.status === "delivered" ? (
          // DELIVERED ONLY (owner ruling, 2 Aug 2026). Marking a stop delivered
          // is precisely what the upload gate stands in front of, so a delivered
          // stop with no K2 is an anomaly worth chasing — and it blocks Approve
          // behind a confirm below.
          //
          // ⚠ A settled-undelivered stop (paid via R3 Q11(a) — reached, admin
          // verified + resumed) deliberately gets NOTHING here. The gate never
          // ran for it, so no K2 was ever expected and none is "missing". The
          // muted "Not delivered" pill beside this already explains the stop.
          // Orange here would manufacture a problem to chase, the same mistake
          // the POD branch above documents avoiding.
          <Pill bg={colors.orangeTint} fg={colors.orange}>
            {t("admin.incentiveApprovals.noK2")}
          </Pill>
        ) : null}
      </View>
    </View>
  );
}

function EditRateModal({
  trip,
  proposed,
  pending,
  onClose,
  onSubmit,
}: {
  trip: Trip;
  proposed: number;
  pending: boolean;
  onClose: () => void;
  onSubmit: (finalAmount: number, reason?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(String(proposed));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parsed = Number(amount);
  const validAmount = Number.isFinite(parsed) && parsed >= 0;
  // An edit changes the amount → a reason is mandatory (server enforces this
  // too; we validate up front so the admin isn't bounced by a 400).
  const changed = validAmount && Math.round(parsed * 100) !== Math.round(proposed * 100);
  const reasonNeeded = changed && reason.trim().length === 0;

  async function submit() {
    setError(null);
    if (!validAmount) {
      setError(t("admin.incentiveApprovals.invalidAmount"));
      return;
    }
    if (reasonNeeded) {
      setError(t("admin.incentiveApprovals.reasonRequired"));
      return;
    }
    try {
      await onSubmit(Math.round(parsed * 100) / 100, changed ? reason.trim() : undefined);
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentiveApprovals.actionFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.incentiveApprovals.editTitle", { ticket: trip.ticket_number })} width={440}>
      <Text style={{ fontSize: font.sm, color: colors.textMuted, marginBottom: 14, lineHeight: 20 }}>
        {t("admin.incentiveApprovals.editIntro", { proposed: formatMoney(proposed) })}
      </Text>
      <Input
        label={t("admin.incentiveApprovals.finalAmount")}
        value={amount}
        onChange={setAmount}
        type="number"
        placeholder={String(proposed)}
      />
      <Input
        label={t("admin.incentiveApprovals.reason") + (changed ? " *" : "")}
        value={reason}
        onChange={setReason}
        placeholder={t("admin.incentiveApprovals.reasonPlaceholder")}
      />
      {error ? <Text style={{ fontSize: font.sm, color: colors.red, marginBottom: 10 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
        <Button variant="ghost" onPress={onClose} disabled={pending} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="success" onPress={submit} disabled={pending || !validAmount || reasonNeeded} style={{ flex: 1 }}>
          {pending ? t("admin.working") : t("admin.incentiveApprovals.approveEdited")}
        </Button>
      </View>
    </Modal>
  );
}
