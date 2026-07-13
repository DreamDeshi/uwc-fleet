// User approval queue — RN port of admin/src/pages/ApprovalsPage.tsx.
// Same hooks (usePendingUsers/useApproveUser), same flow: approve is direct,
// reject confirms first (it revokes access outright — status is re-checked
// on every request). Strings via t() (admin.approvals.*).
import React, { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApproveUser, usePendingUsers } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Avatar, Button, Card, ConfirmDialog, EmptyState, ErrorState, Loading, Pill } from "../components/ui";
import { formatDate } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { AdminUser } from "../types";

export function ApprovalsScreen() {
  const { t } = useTranslation();
  const pending = usePendingUsers();
  const mode = useLayoutMode();

  if (pending.isLoading) return <Loading />;
  if (pending.isError)
    return <ErrorState message={t("admin.approvals.loadError")} onRetry={() => pending.refetch()} />;

  const users = pending.data ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: mode === "wide" ? 24 : 14, gap: 16, maxWidth: 900, width: "100%", alignSelf: "center" }}
      refreshControl={<RefreshControl refreshing={pending.isRefetching} onRefresh={() => pending.refetch()} />}
    >
      <Card
        pad={14}
        style={[
          { flexDirection: "row", alignItems: "center", gap: 12 },
          users.length > 0 && { borderLeftWidth: 5, borderLeftColor: colors.yellow },
        ]}
      >
        {users.length > 0 && (
          <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 11 }}>
            <Text style={{ color: colors.amber, fontSize: font.sm, fontWeight: "800" }}>{users.length}</Text>
          </View>
        )}
        <Text style={{ fontSize: font.md, color: colors.text, flex: 1 }}>
          {users.length === 0 ? t("admin.approvals.noneWaiting") : t("admin.approvals.awaiting")}
        </Text>
      </Card>

      {users.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.approvals.queueEmpty")} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {users.map((u) => (
            <ApprovalRow key={u.id} user={u} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function roleLabel(t: (k: string) => string, role: string): string {
  if (role === "driver") return t("register.roleDriver");
  if (role === "requestor") return t("register.roleRequestor");
  return role;
}

function ApprovalRow({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const approve = useApproveUser();
  const mode = useLayoutMode();
  const [error, setError] = useState<string | null>(null);
  // Rejecting/disabling revokes the account's access outright (status is
  // re-checked on every request) — confirm before firing. Approve stays direct.
  const [confirmingReject, setConfirmingReject] = useState(false);

  async function act(status: "active" | "disabled") {
    setError(null);
    try {
      await approve.mutateAsync({ id: user.id, status });
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.approvals.actionFailed")));
    } finally {
      setConfirmingReject(false);
    }
  }

  const roleColor = user.role === "driver" ? colors.blue : user.role === "requestor" ? colors.green : colors.navy;
  const wide = mode === "wide";

  const actions = (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Button
        variant="ghost"
        size="sm"
        disabled={approve.isPending}
        onPress={() => setConfirmingReject(true)}
        style={{ borderColor: colors.red, flex: wide ? undefined : 1 }}
      >
        <Text style={{ color: colors.red, fontWeight: "700", fontSize: 13.5 }}>{t("admin.approvals.reject")}</Text>
      </Button>
      <Button
        variant="success"
        size="sm"
        disabled={approve.isPending}
        onPress={() => act("active")}
        style={{ flex: wide ? undefined : 1 }}
      >
        {t("admin.approvals.approve")}
      </Button>
    </View>
  );

  return (
    <Card style={{ borderLeftWidth: 5, borderLeftColor: roleColor, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Avatar name={user.name} size={46} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{user.name}</Text>
            <Pill bg={`${roleColor}1a`} fg={roleColor} dot={roleColor}>
              {roleLabel(t, user.role)}
            </Pill>
          </View>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
            {user.phone}
            {user.employee_number ? ` · ${t("admin.approvals.empNo", { num: user.employee_number })}` : ""}
            {` · ${t("admin.approvals.registered", { date: formatDate(user.created_at) })}`}
          </Text>
          {error ? <Text style={{ fontSize: font.sm, color: colors.red, marginTop: 4 }}>{error}</Text> : null}
        </View>
        {/* Wide: actions inline on the right (the web layout). */}
        {wide && actions}
      </View>
      {/* Narrow: full-width tap targets under the identity line. */}
      {!wide && actions}
      {confirmingReject && (
        <ConfirmDialog
          title={t("admin.approvals.rejectTitle")}
          body={t("admin.approvals.rejectBody", { name: user.name, role: roleLabel(t, user.role) })}
          confirmLabel={t("admin.approvals.rejectConfirm")}
          pending={approve.isPending}
          onClose={() => setConfirmingReject(false)}
          onConfirm={() => act("disabled")}
        />
      )}
    </Card>
  );
}
