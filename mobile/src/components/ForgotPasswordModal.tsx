import React, { useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../theme";
import { Button } from "./Button";
import { PasswordField, TextField } from "./Field";
import { api, apiErrorMessage } from "../services/api";
import { isStrongPassword, PASSWORD_MIN_LENGTH } from "../lib/passwordPolicy";

/**
 * Self-service password reset REQUEST (owner-approved design, 20 Aug 2026 —
 * "the request survives nobody answering the phone"). The driver picks their
 * OWN new password right here; nothing is ever transmitted. An admin
 * verifies identity and approves — this modal only ever shows a single
 * "request sent" outcome, never whether the phone matched an account.
 *
 * ⚠ DO NOT add a branch that reads differently for "phone not found" — the
 * server deliberately returns the identical 200 + body either way (non-
 * enumeration, three surfaces: status, body, timing — see routes/auth.ts).
 * A UI that distinguished the two would reopen exactly the oracle the API
 * closes.
 */
export function ForgotPasswordModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [localPhone, setLocalPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const reset = () => {
    setLocalPhone("");
    setPassword("");
    setConfirm("");
    setError(null);
    setSent(false);
  };
  const handleClose = () => {
    reset();
    onClose();
  };

  const onSubmit = async () => {
    setError(null);
    const digits = localPhone.replace(/\D/g, "");
    if (!digits) return setError(t("login.fillFields"));
    if (!isStrongPassword(password)) {
      return setError(t("common.passwordTooWeak", { count: PASSWORD_MIN_LENGTH }));
    }
    if (password !== confirm) return setError(t("register.passwordMismatch"));

    setLoading(true);
    try {
      await api.post("/auth/password-reset-requests", {
        phone: `+60${digits}`,
        new_password: password,
      });
      setSent(true);
    } catch (err) {
      // Only validation/network/rate-limit errors ever reach here — never
      // "phone not found", which the server deliberately never sends.
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>{t("login.resetRequestTitle")}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {sent ? (
            <View style={styles.sentBlock}>
              <View style={styles.sentIcon}>
                <Ionicons name="checkmark" size={28} color={colors.white} />
              </View>
              <Text style={styles.sentText}>{t("login.resetRequestSent")}</Text>
              <Button title={t("common.close")} onPress={handleClose} style={{ marginTop: 20, alignSelf: "stretch" }} />
            </View>
          ) : (
            <>
              <Text style={styles.subtitle}>{t("login.resetRequestSubtitle")}</Text>

              <TextField
                label={t("login.phone")}
                value={localPhone}
                onChangeText={setLocalPhone}
                placeholder={t("login.phonePlaceholder")}
                keyboardType="phone-pad"
                leftIcon="call-outline"
              />
              <PasswordField
                label={t("login.resetNewPassword")}
                value={password}
                onChangeText={setPassword}
                placeholder={t("register.passwordPlaceholder", { count: PASSWORD_MIN_LENGTH })}
              />
              <PasswordField
                label={t("register.confirmPassword")}
                value={confirm}
                onChangeText={setConfirm}
                placeholder={t("register.passwordPlaceholder", { count: PASSWORD_MIN_LENGTH })}
              />

              {error ? (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle" size={18} color={colors.red} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button
                title={t("login.resetRequestSubmit")}
                onPress={onSubmit}
                loading={loading}
                style={{ marginTop: 16, alignSelf: "stretch" }}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 420, backgroundColor: colors.white, borderRadius: radius.lg, padding: 24, ...shadow.card },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  title: { fontSize: 18, fontWeight: "800", color: colors.navy },
  subtitle: { fontSize: 13, color: colors.textMuted, marginBottom: 16, lineHeight: 18 },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.tintRed,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  errorText: { flex: 1, color: colors.red, fontSize: 13, fontWeight: "600" },
  sentBlock: { alignItems: "center", paddingTop: 8 },
  sentIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  sentText: { fontSize: 15, color: colors.navy, textAlign: "center", lineHeight: 21, fontWeight: "600" },
});
