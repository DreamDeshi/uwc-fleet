// The dispatcher's Request Change queue (Mr. Teh A19, 29 Jul 2026):
//
// > "the requestor can click 'Request Change', and the system sends the change
// >  to the dispatcher/admin for approval."
//
// A request is a PROPOSAL — nothing on the booking has moved. Approving replays
// it through the same validated edit path a requestor's own edit uses, so it
// can legitimately FAIL at approval time (the assigned lorry no longer fits, a
// consignee was deactivated since). The server message is surfaced verbatim
// rather than flattened, because "why can't I approve this" is the question the
// admin will actually have.
//
// Design mirrors IncentiveApprovalsScreen: summary count card + per-item cards,
// inline actions on wide, full-width on narrow.
import React, { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useOpenChangeRequests, useDecideChangeRequest, type ChangeRequestRow } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Pill } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";

export function ChangeRequestsScreen() {
  const { t } = useTranslation();
  const queue = useOpenChangeRequests();
  const mode = useLayoutMode();

  if (queue.isLoading) return <Loading />;
  if (queue.isError)
    return <ErrorState message={t("changeRequest.loadError")} onRetry={() => queue.refetch()} />;

  const rows = queue.data ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={
        mode === "wide"
          ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 }
          : { padding: 14, gap: 16 }
      }
      refreshControl={<RefreshControl refreshing={queue.isRefetching} onRefresh={() => queue.refetch()} />}
    >
      <Card
        pad={14}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 12 },
          rows.length > 0 && { borderLeftWidth: 5, borderLeftColor: colors.orange },
        ]}
      >
        {rows.length > 0 && (
          <View style={{ backgroundColor: colors.orangeTint, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 11 }}>
            <Text style={{ color: colors.orange, fontSize: font.sm, fontWeight: "800" }}>{rows.length}</Text>
          </View>
        )}
        <Text style={{ fontSize: font.md, color: colors.text, flex: 1 }}>
          {rows.length === 0 ? t("changeRequest.noneWaiting") : t("changeRequest.awaiting", { count: rows.length })}
        </Text>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <EmptyState message={t("changeRequest.queueEmpty")} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {rows.map((r) => (
            <RequestCard key={r.id} row={r} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function RequestCard({ row }: { row: ChangeRequestRow }) {
  const { t } = useTranslation();
  const decide = useDecideChangeRequest();
  const wide = useLayoutMode() === "wide";

  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function run(decision: "approve" | "reject", noteText?: string) {
    setError(null);
    try {
      await decide.mutateAsync({
        tripId: row.trip_id,
        id: row.id,
        decision,
        note: noteText,
        version: row.version,
      });
      setRejecting(false);
      setNote("");
    } catch (e) {
      // Verbatim: an approval can fail for a real operational reason (the lorry
      // no longer fits), and the admin needs to read exactly which.
      setError(apiErrorMessage(e, t("changeRequest.actionFailed")));
    }
  }

  const actions = (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button
        variant="outline"
        size="sm"
        disabled={decide.isPending}
        onPress={() => setRejecting(true)}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("changeRequest.reject")}
      </Button>
      <Button
        variant="success"
        size="sm"
        disabled={decide.isPending}
        onPress={() => run("approve")}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("changeRequest.approve")}
      </Button>
    </View>
  );

  return (
    <Card style={{ borderLeftWidth: 5, borderLeftColor: colors.orange, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: "800", color: colors.text }}>{row.ticket_number}</Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
            {row.requestor_name}
            {row.truck_plate ? ` · ${row.truck_plate}` : ""}
            {row.driver_name ? ` · ${row.driver_name}` : ""}
          </Text>
          <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 2 }}>
            {t("changeRequest.requestedAt", { at: formatDateTime(row.requested_at) })}
          </Text>
        </View>
        <Pill bg={colors.yellowTint} fg={colors.amber}>{t("changeRequest.pendingPill")}</Pill>
      </View>

      {/* WHAT changed, in the same wording the trip timeline uses. */}
      <View style={{ backgroundColor: colors.bg, borderRadius: radius.md, padding: 12 }}>
        <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: "700", marginBottom: 4 }}>
          {t("changeRequest.whatChanged")}
        </Text>
        <Text style={{ fontSize: font.md, color: colors.text }}>{row.summary}</Text>
      </View>

      <Text style={{ fontSize: font.xs, color: colors.textMuted, lineHeight: 17 }}>
        {t("changeRequest.approveHint")}
      </Text>

      {error ? (
        <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
      ) : null}

      {actions}

      <Modal open={rejecting} onClose={() => setRejecting(false)} title={t("changeRequest.rejectTitle")}>
        <Text style={{ color: colors.textMuted, fontSize: font.sm, marginBottom: 10 }}>
          {t("changeRequest.rejectBody")}
        </Text>
        <Input value={note} onChange={setNote} placeholder={t("changeRequest.rejectPlaceholder")} />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button variant="outline" style={{ flex: 1 }} onPress={() => setRejecting(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            style={{ flex: 1 }}
            disabled={decide.isPending || note.trim().length === 0}
            onPress={() => run("reject", note.trim())}
          >
            {t("changeRequest.reject")}
          </Button>
        </View>
      </Modal>
    </Card>
  );
}
