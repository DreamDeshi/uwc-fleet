// Self-service account modals (Part A) — shared by the driver/requestor Profile
// screen AND the admin Settings screen. Deliberately provider-light: errors are
// shown inline (no useToast) so the same components render in either navigation
// tree. On success they close; the caller's screen re-reads `user` via
// AuthContext.refreshMe (fired here after a profile save).
import React, { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { TextField, PressableField } from "./Field";
import { OptionsModal } from "./OptionsModal";
import { useDepartments, useUpdateProfile, useChangePassword } from "../hooks/queries";
import { apiErrorMessage } from "../services/api";

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

// ── Edit profile (display name + department) ────────────────────────────────
export function EditProfileModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user, refreshMe } = useAuth();
  const departments = useDepartments();
  const update = useUpdateProfile();

  const [name, setName] = useState(user?.name ?? "");
  const [departmentId, setDepartmentId] = useState<string | undefined>(user?.department?.id);
  const [deptOpen, setDeptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the current user each time the modal opens.
  useEffect(() => {
    if (visible) {
      setName(user?.name ?? "");
      setDepartmentId(user?.department?.id);
      setError(null);
    }
  }, [visible, user?.name, user?.department?.id]);

  const deptName =
    departments.data?.find((d) => d.id === departmentId)?.name ?? user?.department?.name;

  const submit = () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("account.nameRequired"));
      return;
    }
    const payload: { name?: string; department_id?: string } = {};
    if (trimmed !== user?.name) payload.name = trimmed;
    if (departmentId && departmentId !== user?.department?.id) payload.department_id = departmentId;
    if (Object.keys(payload).length === 0) {
      onClose(); // nothing changed
      return;
    }
    update.mutate(payload, {
      onSuccess: async () => {
        await refreshMe();
        onClose();
      },
      onError: (err) => setError(apiErrorMessage(err, t("common.errorGeneric"))),
    });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <Text style={styles.title}>{t("account.editProfile")}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 16 }}>
            <TextField
              label={t("account.name")}
              value={name}
              onChangeText={setName}
              placeholder={t("account.namePlaceholder")}
              leftIcon="person-outline"
              autoCapitalize="words"
            />
            <PressableField
              label={t("profile.department")}
              value={deptName}
              placeholder={t("account.selectDepartment")}
              onPress={() => setDeptOpen(true)}
              leftIcon="business-outline"
            />
            <ErrorLine message={error} />
          </ScrollView>
          <View style={styles.actions}>
            <Button title={t("common.cancel")} variant="outline" onPress={onClose} style={{ flex: 1 }} />
            <Button
              title={t("common.save")}
              onPress={submit}
              loading={update.isPending}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>

      <OptionsModal
        visible={deptOpen}
        title={t("profile.department")}
        options={(departments.data ?? []).map((d) => ({ label: d.name, value: d.id }))}
        selectedValue={departmentId}
        onSelect={setDepartmentId}
        onClose={() => setDeptOpen(false)}
      />
    </Modal>
  );
}

// ── Change password (current + new + confirm) ───────────────────────────────
export function ChangePasswordModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const change = useChangePassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
    }
  }, [visible]);

  const submit = () => {
    setError(null);
    if (!current) {
      setError(t("account.currentRequired"));
      return;
    }
    if (next.length < 6) {
      setError(t("register.passwordTooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("register.passwordMismatch"));
      return;
    }
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => onClose(),
        onError: (err) => setError(apiErrorMessage(err, t("common.errorGeneric"))),
      }
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <Text style={styles.title}>{t("account.changePassword")}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 16 }}>
            <TextField
              label={t("account.currentPassword")}
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              leftIcon="lock-closed-outline"
              autoCapitalize="none"
            />
            <TextField
              label={t("account.newPassword")}
              value={next}
              onChangeText={setNext}
              secureTextEntry
              leftIcon="key-outline"
              autoCapitalize="none"
            />
            <TextField
              label={t("account.confirmPassword")}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              leftIcon="key-outline"
              autoCapitalize="none"
            />
            <ErrorLine message={error} />
          </ScrollView>
          <View style={styles.actions}>
            <Button title={t("common.cancel")} variant="outline" onPress={onClose} style={{ flex: 1 }} />
            <Button
              title={t("account.updatePassword")}
              onPress={submit}
              loading={change.isPending}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 24, width: "100%", maxWidth: 440, maxHeight: "85%" },
  title: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  errorBox: { backgroundColor: colors.tintRed, borderRadius: radius.md, padding: 12, marginBottom: 4 },
  errorText: { color: colors.red, fontSize: 13, fontWeight: "600" },
});
