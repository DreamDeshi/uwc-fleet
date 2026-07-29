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
import { Image, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { api, apiErrorMessage } from "../services/api";
import { appendPhoto, UPLOAD_HEADERS } from "../hooks/queries";
import { pickFeedbackImage } from "../lib/photo";
import type { PickedPhoto } from "../lib/photo";

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
  const [image, setImage] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const close = () => {
    setStatus(null);
    setMessage("");
    setImage(null);
    onClose();
  };

  const attach = async () => {
    setStatus(null);
    const picked = await pickFeedbackImage();
    // Cancel and a refused permission both land here. Feedback sends fine
    // without a picture, so neither is worth an error — the button simply
    // does nothing visible.
    if (picked) setImage(picked);
  };

  const submit = async () => {
    if (message.trim().length < 5) {
      setStatus({ kind: "err", text: t("feedback.tooShort") });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (image) {
        // Multipart only when there IS a picture; the plain JSON path is
        // untouched for everyone who just types.
        const form = new FormData();
        form.append("category", category);
        form.append("message", message.trim());
        form.append("screen", screen);
        await appendPhoto(form, "image", image);
        await api.post("/feedback", form, { headers: UPLOAD_HEADERS, timeout: 60_000 });
      } else {
        await api.post("/feedback", { category, message: message.trim(), screen });
      }
      // Keep the modal open on the success note so the sender sees it landed;
      // the text and picture clear so a second report can follow immediately.
      setMessage("");
      setImage(null);
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

          {/* Optional screenshot — "a small area to show bugs for the dev to
              know" (owner, 29 Jul). A thumbnail once picked, so the sender can
              see WHICH shot is attached and swap it before sending. */}
          {image ? (
            <View style={styles.imageRow}>
              <Image source={{ uri: image.uri }} style={styles.thumb} resizeMode="cover" />
              <Text style={styles.imageName} numberOfLines={1}>{image.name}</Text>
              <TouchableOpacity
                onPress={() => setImage(null)}
                hitSlop={10}
                accessibilityLabel={t("feedback.removeImage")}
              >
                <Ionicons name="close-circle" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.attachBtn} onPress={attach} activeOpacity={0.8}>
              <Ionicons name="image-outline" size={18} color={colors.blue} />
              <Text style={styles.attachText}>{t("feedback.addImage")}</Text>
            </TouchableOpacity>
          )}

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
  attachBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  attachText: { fontSize: 14, fontWeight: "700", color: colors.blue },
  imageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.fieldBg,
  },
  thumb: { width: 34, height: 34, borderRadius: 6, backgroundColor: colors.border },
  imageName: { flex: 1, fontSize: 13, color: colors.textMuted },
});
