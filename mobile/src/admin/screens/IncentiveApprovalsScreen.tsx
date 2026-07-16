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
import { formatMoney, formatDateTime } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { Trip, TripStop } from "../types";

// The engine proposal stored on the trip (what pay defaults to at approval).
const proposedAmount = (trip: Trip): number => Number(trip.incentive_earned ?? 0);

// The trip's first delivery confirm — the instant it flipped to pending_approval.
function deliveredAt(trip: Trip): string | null {
  return trip.stops.reduce<string | null>(
    (earliest, s) =>
      s.delivered_at && (!earliest || s.delivered_at < earliest) ? s.delivered_at : earliest,
    null
  );
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

  const proposed = proposedAmount(trip);
  const delivered = deliveredAt(trip);

  async function approveAsIs() {
    setError(null);
    try {
      // No final_amount → the server pays the proposal exactly.
      await approve.mutateAsync({ id: trip.id });
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentiveApprovals.actionFailed")));
    }
  }

  const stops = [...trip.stops].sort((a, b) => a.sequence - b.sequence);

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
        onPress={approveAsIs}
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
    </Card>
  );
}

function StopRow({ stop }: { stop: TripStop }) {
  const { t } = useTranslation();
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
            the proposal is what it is before approving. Null on pre-feature trips. */}
        {stop.points_awarded != null ? (
          <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 1 }}>
            {t("admin.incentiveApprovals.dropPoints", { pts: stop.points_awarded })}
            {stop.was_repeat ? ` · ${t("admin.incentiveApprovals.repeat")}` : ""}
            {stop.zone_code ? ` · ${stop.zone_code}` : ""}
          </Text>
        ) : null}
      </View>
      {stop.pod_photo ? (
        <Pressable onPress={() => Linking.openURL(stop.pod_photo!)}>
          <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>📷 POD ↗</Text>
        </Pressable>
      ) : (
        <Pill bg={colors.orangeTint} fg={colors.orange}>
          {t("admin.incentiveApprovals.noPod")}
        </Pill>
      )}
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
