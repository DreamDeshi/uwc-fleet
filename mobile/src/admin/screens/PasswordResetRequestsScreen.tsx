// Password reset request queue (owner-approved design, 20 Aug 2026): "the
// request survives nobody answering the phone." A driver picks their own new
// password when they can't log in; identity verification is the whole job
// here, so the row surfaces exactly what the design asked for — name,
// employee number, truck, when raised, whether the account is currently
// locked out, and the last successful sign-in. Same layout family as
// ApprovalsScreen (approve direct, a destructive action confirms first).
import React, { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  useApprovePasswordResetRequest,
  useDismissPasswordResetRequest,
  usePasswordResetRequests,
} from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Avatar, Button, Card, ConfirmDialog, EmptyState, ErrorState, Loading, Pill } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { PasswordResetRequest } from "../types";

export function PasswordResetRequestsScreen() {
  const { t } = useTranslation();
  const requests = usePasswordResetRequests();
  const mode = useLayoutMode();

  if (requests.isLoading) return <Loading />;
  if (requests.isError)
    return <ErrorState message={t("admin.passwordResets.loadError")} onRetry={() => requests.refetch()} />;

  const rows = requests.data ?? [];
  const pending = rows.filter((r) => r.status === "pending");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={mode === "wide" ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      refreshControl={<RefreshControl refreshing={requests.isRefetching} onRefresh={() => requests.refetch()} />}
    >
      <Card
        pad={14}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 12 },
          pending.length > 0 && { borderLeftWidth: 5, borderLeftColor: colors.yellow },
        ]}
      >
        {pending.length > 0 && (
          <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 11 }}>
            <Text style={{ color: colors.amber, fontSize: font.sm, fontWeight: "800" }}>{pending.length}</Text>
          </View>
        )}
        <Text style={{ fontSize: font.md, color: colors.text, flex: 1 }}>
          {pending.length === 0
            ? t("admin.passwordResets.noneWaiting")
            : t("admin.passwordResets.awaiting", { count: pending.length })}
        </Text>
      </Card>

      {pending.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.passwordResets.queueEmpty")} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {pending.map((r) => (
            <RequestRow key={r.id} request={r} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function RequestRow({ request }: { request: PasswordResetRequest }) {
  const { t } = useTranslation();
  const approve = useApprovePasswordResetRequest();
  const dismiss = useDismissPasswordResetRequest();
  const mode = useLayoutMode();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const busy = approve.isPending || dismiss.isPending;

  async function onApprove() {
    setError(null);
    try {
      await approve.mutateAsync(request.id);
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.passwordResets.actionFailed")));
    }
  }
  async function onDismiss() {
    setError(null);
    try {
      await dismiss.mutateAsync(request.id);
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.passwordResets.actionFailed")));
    } finally {
      setConfirmingDismiss(false);
    }
  }

  const wide = mode === "wide";
  const { user } = request;

  const actions = (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onPress={() => setConfirmingDismiss(true)}
        style={{ borderColor: colors.textMuted, flex: wide ? undefined : 1 }}
      >
        <Text style={{ color: colors.textMuted, fontWeight: "700", fontSize: 13.5 }}>
          {t("admin.passwordResets.dismiss")}
        </Text>
      </Button>
      <Button
        variant="success"
        size="sm"
        disabled={busy}
        onPress={onApprove}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("admin.passwordResets.approve")}
      </Button>
    </View>
  );

  return (
    <Card style={{ borderLeftWidth: 5, borderLeftColor: user.is_locked ? colors.red : colors.blue, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Avatar name={user.name} size={46} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{user.name}</Text>
            {user.is_locked ? (
              <Pill bg={`${colors.red}1a`} fg={colors.red} dot={colors.red}>
                {t("admin.passwordResets.locked")}
              </Pill>
            ) : null}
          </View>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
            {user.phone}
            {user.employee_number ? ` · ${t("admin.approvals.empNo", { num: user.employee_number })}` : ""}
            {user.assigned_truck_plate ? ` · ${user.assigned_truck_plate}` : ""}
          </Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
            {t("admin.passwordResets.requested", { date: formatDateTime(request.requested_at) })}
            {" · "}
            {user.last_login_at
              ? t("admin.passwordResets.lastLogin", { date: formatDateTime(user.last_login_at) })
              : t("admin.passwordResets.neverLoggedIn")}
          </Text>
          {error ? <Text style={{ fontSize: font.sm, color: colors.red, marginTop: 4 }}>{error}</Text> : null}
        </View>
        {wide && actions}
      </View>
      {!wide && actions}
      {confirmingDismiss && (
        <ConfirmDialog
          title={t("admin.passwordResets.dismissTitle")}
          body={t("admin.passwordResets.dismissBody", { name: user.name })}
          confirmLabel={t("admin.passwordResets.dismissConfirm")}
          pending={dismiss.isPending}
          onClose={() => setConfirmingDismiss(false)}
          onConfirm={onDismiss}
        />
      )}
    </Card>
  );
}
