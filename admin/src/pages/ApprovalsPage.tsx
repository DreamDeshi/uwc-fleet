import { useState } from "react";
import { useApproveUser, usePendingUsers } from "@/hooks/queries";
import { colors } from "@/theme";
import { Avatar, Button, Card, ConfirmDialog, EmptyState, ErrorState, Loading, Pill } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { apiErrorMessage } from "@/services/api";
import type { AdminUser } from "@/types";

export function ApprovalsPage() {
  const pending = usePendingUsers();

  if (pending.isLoading) return <Loading />;
  if (pending.isError) return <ErrorState message="Could not load pending users." onRetry={() => pending.refetch()} />;

  const users = pending.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card pad={14} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 14, color: colors.text }}>
          {users.length === 0
            ? "No accounts are waiting for approval."
            : `${users.length} account${users.length === 1 ? "" : "s"} awaiting approval. Approving sets the account to active so the person can log in.`}
        </span>
      </Card>

      {users.length === 0 ? (
        <Card><EmptyState message="The approval queue is empty." /></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {users.map((u) => (
            <ApprovalRow key={u.id} user={u} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalRow({ user }: { user: AdminUser }) {
  const approve = useApproveUser();
  const [error, setError] = useState<string | null>(null);
  // Rejecting/disabling revokes the account's access outright (status is
  // re-checked on every request) — confirm before firing. Approve stays direct.
  const [confirmingReject, setConfirmingReject] = useState(false);

  async function act(status: "active" | "disabled") {
    setError(null);
    try {
      await approve.mutateAsync({ id: user.id, status });
    } catch (e) {
      setError(apiErrorMessage(e, "Action failed."));
    } finally {
      setConfirmingReject(false);
    }
  }

  const roleColor = user.role === "driver" ? colors.blue : user.role === "requestor" ? colors.green : colors.navy;

  return (
    <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <Avatar name={user.name} size={46} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{user.name}</span>
          <Pill bg={`${roleColor}1a`} fg={roleColor}>{user.role}</Pill>
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
          {user.phone}
          {user.employee_number ? ` · Emp #${user.employee_number}` : ""} · Registered {formatDate(user.created_at)}
        </div>
        {error && <div style={{ fontSize: 13, color: colors.red, marginTop: 4 }}>{error}</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="ghost" size="sm" disabled={approve.isPending} onClick={() => setConfirmingReject(true)} style={{ color: colors.red, borderColor: colors.red }}>
          Reject
        </Button>
        <Button variant="success" size="sm" disabled={approve.isPending} onClick={() => act("active")}>
          Approve
        </Button>
      </div>
      {confirmingReject && (
        <ConfirmDialog
          title="Reject this account?"
          body={
            <>
              Reject <strong>{user.name}</strong> ({user.role})? The account is disabled and
              cannot log in until an admin re-approves it.
            </>
          }
          confirmLabel="Reject Account"
          pending={approve.isPending}
          onClose={() => setConfirmingReject(false)}
          onConfirm={() => act("disabled")}
        />
      )}
    </Card>
  );
}
