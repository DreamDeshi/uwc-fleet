// "Report a problem or idea" — the in-app feedback channel for EVERY role:
// driver + requestor reach it from the shared Profile screen, admin from the
// admin Settings screen. Submissions POST /feedback and land in the admin's
// User-feedback inbox (AuditLog-backed — durable, unlike the client-errors
// ring). Distinct from automatic crash reporting (lib/errorReporting) and
// from the driver's delivery-exception report.
//
// Status is shown inline (no useToast) so the same component renders in
// either navigation tree — the same rule AccountModals follows.
import React, { useState } from "react";
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { api, apiErrorMessage } from "../services/api";

const CATEGORIES = ["bug", "idea", "other"] as const;
type Category = (typeof CATEGORIES)[number];

export function FeedbackModal({
  visible,
  screen,
  onClose,
}: {
  visible: boolean;
  /** Where the modal was opened from — helps triage ("driver-profile", …). */
  screen: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>("bug");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const close = () => {
    setStatus(null);
    setMessage("");
    onClose();
  };

  const submit = async () => {
    if (message.trim().length < 5) {
      setStatus({ kind: "err", text: t("feedback.tooShort") });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.post("/feedback", { category, message: message.trim(), screen });
      // Keep the modal open on the success note so the sender sees it landed;
      // the text is cleared so a second idea can follow immediately.
      setMessage("");
      setStatus({ kind: "ok", text: t("feedback.sent") });
    } catch (err) {
      setStatus({ kind: "err", text: apiErrorMessage(err) || t("feedback.failed") });
    } finally {
      setBusy(false);
    }
  };

  const catLabel: Record<Category, string> = {
    bug: t("feedback.categoryBug"),
    idea: t("feedback.categoryIdea"),
    other: t("feedback.categoryOther"),
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <Text style={styles.title}>{t("feedback.title")}</Text>
          <Text style={styles.hint}>{t("feedback.hint")}</Text>

          <View style={styles.catRow}>
            {CATEGORIES.map((c) => {
              const active = category === c;
              return (
                <TouchableOpacity
                  key={c}
                  style={[styles.catBtn, active && styles.catBtnActive]}
                  onPress={() => setCategory(c)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.catText, active && { color: colors.blue }]}>{catLabel[c]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            style={styles.input}
            multiline
            value={message}
            onChangeText={setMessage}
            placeholder={t("feedback.placeholder")}
            placeholderTextColor={colors.textFaint}
            maxLength={1000}
          />

          {status ? (
            <Text style={[styles.status, { color: status.kind === "ok" ? colors.greenText : colors.red }]}>
              {status.text}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <Button title={t("common.close")} variant="outline" onPress={close} style={{ flex: 1 }} />
            <Button title={t("feedback.submit")} onPress={submit} loading={busy} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 24, width: "100%", maxWidth: 480 },
  title: { fontSize: 17, fontWeight: "800", color: colors.navy },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: 6, lineHeight: 18 },
  catRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  catBtn: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border },
  catBtnActive: { borderColor: colors.blue, borderWidth: 2, backgroundColor: colors.tintBlue },
  catText: { fontSize: 14, fontWeight: "700", color: colors.textMuted },
  input: {
    marginTop: 12,
    minHeight: 110,
    textAlignVertical: "top",
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    fontSize: 14,
    color: colors.navy,
    backgroundColor: colors.fieldBg,
  },
  status: { fontSize: 13, fontWeight: "700", marginTop: 10 },
});
