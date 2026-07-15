// ALL USERS (Part B) — the admin's full account directory: every user with
// role/status/phone/name, and per-user actions (edit identity, promote/demote
// role, activate/deactivate, reset password). Table on wide, stacked cards on
// narrow (OWNER RULING — see ui.tsx TableScroll). All mutations are audited and
// guarded server-side (last-admin, self-lockout, phone uniqueness).
import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  useUsers,
  useChangeUserRole,
  useSetUserStatus,
  useResetUserPassword,
  useAdminUpdateUser,
} from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Avatar,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  Pill,
  SearchInput,
  SegmentedFilter,
  TableCell,
  TableHeader,
  TableRow,
  TableScroll,
} from "../components/ui";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { AdminUser, Role, UserStatus } from "../types";

type RoleFilter = "any" | Role;

const ROLE_COLORS: Record<string, string> = {
  admin: colors.navy,
  driver: colors.blue,
  requestor: colors.green,
};

function roleLabel(t: (k: string) => string, role: string): string {
  if (role === "admin") return t("admin.users.roleAdmin");
  if (role === "driver") return t("register.roleDriver");
  if (role === "requestor") return t("register.roleRequestor");
  return role;
}

function statusMeta(status: string): { key: string; color: string } {
  if (status === "active") return { key: "admin.users.statusActive", color: colors.green };
  if (status === "disabled") return { key: "admin.users.statusDisabled", color: colors.red };
  return { key: "admin.users.statusPending", color: colors.amber };
}

export function AllUsersScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const wide = mode === "wide";
  const users = useUsers();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("any");
  const [managed, setManaged] = useState<AdminUser | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data ?? []).filter((u) => {
      if (roleFilter !== "any" && u.role !== roleFilter) return false;
      if (!q) return true;
      return u.name.toLowerCase().includes(q) || u.phone.toLowerCase().includes(q);
    });
  }, [users.data, search, roleFilter]);

  if (users.isLoading) return <Loading />;
  if (users.isError)
    return <ErrorState message={t("admin.users.loadError")} onRetry={() => users.refetch()} />;

  const roleFilters: { value: RoleFilter; label: string; count?: number }[] = [
    { value: "any", label: t("admin.users.filterAll"), count: users.data?.length },
    { value: "admin", label: t("admin.users.filterAdmins") },
    { value: "driver", label: t("admin.users.filterDrivers") },
    { value: "requestor", label: t("admin.users.filterRequestors") },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 14 }}
      refreshControl={<RefreshControl refreshing={users.isRefetching} onRefresh={() => users.refetch()} />}
    >
      <View style={{ gap: 12 }}>
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.users.searchPlaceholder")} style={{ minWidth: 0 }} />
        <SegmentedFilter<RoleFilter> value={roleFilter} onChange={setRoleFilter} options={roleFilters} />
      </View>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.users.empty")} />
        </Card>
      ) : wide ? (
        <Card pad={0}>
          <TableScroll minWidth={720}>
            <TableHeader>
              <TableCell header flex={2.2}>{t("admin.users.colName")}</TableCell>
              <TableCell header flex={1.4}>{t("admin.users.colRole")}</TableCell>
              <TableCell header flex={1.4}>{t("admin.users.colStatus")}</TableCell>
              <TableCell header flex={1.8}>{t("admin.users.colPhone")}</TableCell>
              <TableCell header flex={1}>{t("admin.users.colActions")}</TableCell>
            </TableHeader>
            {filtered.map((u) => {
              const sm = statusMeta(u.status);
              const rc = ROLE_COLORS[u.role] ?? colors.navy;
              return (
                <TableRow key={u.id}>
                  <TableCell flex={2.2}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <Avatar name={u.name} size={32} />
                      <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{u.name}</Text>
                    </View>
                  </TableCell>
                  <TableCell flex={1.4}>
                    <Pill bg={`${rc}1a`} fg={rc} dot={rc}>{roleLabel(t, u.role)}</Pill>
                  </TableCell>
                  <TableCell flex={1.4}>
                    <Pill bg={`${sm.color}1a`} fg={sm.color} dot={sm.color}>{t(sm.key)}</Pill>
                  </TableCell>
                  <TableCell flex={1.8}>{u.phone}</TableCell>
                  <TableCell flex={1}>
                    <Button size="sm" variant="outline" onPress={() => setManaged(u)}>{t("admin.users.manage")}</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableScroll>
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {filtered.map((u) => {
            const sm = statusMeta(u.status);
            const rc = ROLE_COLORS[u.role] ?? colors.navy;
            return (
              <Card key={u.id} style={{ gap: 12 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <Avatar name={u.name} size={42} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{u.name}</Text>
                    <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>{u.phone}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Pill bg={`${rc}1a`} fg={rc} dot={rc}>{roleLabel(t, u.role)}</Pill>
                  <Pill bg={`${sm.color}1a`} fg={sm.color} dot={sm.color}>{t(sm.key)}</Pill>
                </View>
                <Button variant="outline" size="sm" full onPress={() => setManaged(u)}>{t("admin.users.manage")}</Button>
              </Card>
            );
          })}
        </View>
      )}

      {managed ? <ManageUserModal user={managed} onClose={() => setManaged(null)} /> : null}
    </ScrollView>
  );
}

// ── Per-user management modal ───────────────────────────────────────────────
function ManageUserModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useTranslation();
  const updateUser = useAdminUpdateUser();
  const changeRole = useChangeUserRole();
  const setStatus = useSetUserStatus();
  const resetPassword = useResetUserPassword();

  // Identity fields, seeded from the row.
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone);
  const [employeeNo, setEmployeeNo] = useState(user.employee_number ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [newPassword, setNewPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const clear = () => {
    setError(null);
    setNotice(null);
  };
  const fail = (e: unknown) => setError(apiErrorMessage(e, t("common.errorGeneric")));

  const saveDetails = () => {
    clear();
    const body: { name?: string; phone?: string; employee_number?: string } = {};
    if (name.trim() && name.trim() !== user.name) body.name = name.trim();
    if (phone.trim() && phone.trim() !== user.phone) body.phone = phone.trim();
    if (employeeNo.trim() && employeeNo.trim() !== (user.employee_number ?? "")) body.employee_number = employeeNo.trim();
    if (Object.keys(body).length === 0) {
      setNotice(t("admin.users.nothingToSave"));
      return;
    }
    updateUser.mutate(
      { id: user.id, ...body },
      { onSuccess: () => setNotice(t("admin.users.detailsSaved")), onError: fail }
    );
  };

  const applyRole = () => {
    clear();
    if (role === user.role) {
      setNotice(t("admin.users.roleUnchanged"));
      return;
    }
    changeRole.mutate(
      { id: user.id, role },
      { onSuccess: () => setNotice(t("admin.users.roleUpdated")), onError: fail }
    );
  };

  const applyStatus = (status: UserStatus) => {
    clear();
    setStatus.mutate(
      { id: user.id, status },
      {
        onSuccess: () => {
          setNotice(status === "active" ? t("admin.users.activated") : t("admin.users.deactivated"));
          setConfirmDeactivate(false);
        },
        onError: (e) => {
          fail(e);
          setConfirmDeactivate(false);
        },
      }
    );
  };

  const doReset = () => {
    clear();
    if (newPassword.length < 6) {
      setError(t("register.passwordTooShort"));
      return;
    }
    resetPassword.mutate(
      { user_id: user.id, new_password: newPassword },
      {
        onSuccess: () => {
          setNewPassword("");
          setNotice(t("admin.users.passwordResetDone"));
        },
        onError: fail,
      }
    );
  };

  const roleOptions = [
    { value: "admin" as Role, label: t("admin.users.roleAdmin") },
    { value: "driver" as Role, label: t("register.roleDriver") },
    { value: "requestor" as Role, label: t("register.roleRequestor") },
  ];

  return (
    <Modal open onClose={onClose} title={user.name} width={520}>
      {error ? (
        <View style={{ backgroundColor: `${colors.red}14`, borderRadius: radius.md, padding: 11, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm, fontWeight: "600" }}>{error}</Text>
        </View>
      ) : null}
      {notice ? (
        <View style={{ backgroundColor: `${colors.green}14`, borderRadius: radius.md, padding: 11, marginBottom: 12 }}>
          <Text style={{ color: colors.green, fontSize: font.sm, fontWeight: "600" }}>{notice}</Text>
        </View>
      ) : null}

      {/* Identity */}
      <Text style={styles.section}>{t("admin.users.sectionDetails")}</Text>
      <Input label={t("account.name")} value={name} onChange={setName} />
      <Input label={t("profile.phone")} value={phone} onChange={setPhone} />
      <Input label={t("profile.employeeNumber")} value={employeeNo} onChange={setEmployeeNo} />
      <Button onPress={saveDetails} disabled={updateUser.isPending} style={{ alignSelf: "flex-start" }}>
        {t("common.save")}
      </Button>

      {/* Role */}
      <Text style={styles.section}>{t("admin.users.sectionRole")}</Text>
      <View style={{ marginBottom: 12 }}>
        <SegmentedFilter<Role> value={role} onChange={setRole} options={roleOptions} />
      </View>
      <Button variant="outline" onPress={applyRole} disabled={changeRole.isPending} style={{ alignSelf: "flex-start" }}>
        {t("admin.users.applyRole")}
      </Button>

      {/* Status */}
      <Text style={styles.section}>{t("admin.users.sectionStatus")}</Text>
      {user.status === "active" ? (
        <Button variant="danger" onPress={() => setConfirmDeactivate(true)} disabled={setStatus.isPending} style={{ alignSelf: "flex-start" }}>
          {t("admin.users.deactivate")}
        </Button>
      ) : (
        <Button variant="success" onPress={() => applyStatus("active")} disabled={setStatus.isPending} style={{ alignSelf: "flex-start" }}>
          {t("admin.users.activate")}
        </Button>
      )}

      {/* Password reset */}
      <Text style={styles.section}>{t("admin.users.sectionPassword")}</Text>
      <Input label={t("account.newPassword")} value={newPassword} onChange={setNewPassword} placeholder={t("admin.users.tempPasswordHint")} />
      <Button variant="accent" onPress={doReset} disabled={resetPassword.isPending} style={{ alignSelf: "flex-start" }}>
        {t("admin.users.resetPassword")}
      </Button>

      {confirmDeactivate ? (
        <ConfirmDialog
          title={t("admin.users.deactivateTitle")}
          body={t("admin.users.deactivateBody", { name: user.name })}
          confirmLabel={t("admin.users.deactivate")}
          pending={setStatus.isPending}
          onClose={() => setConfirmDeactivate(false)}
          onConfirm={() => applyStatus("disabled")}
        />
      ) : null}
    </Modal>
  );
}

const styles = {
  section: {
    fontSize: font.md,
    fontWeight: "800" as const,
    color: colors.text,
    marginTop: 18,
    marginBottom: 10,
  },
};
