import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Image, ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, spacing } from "../theme";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { capturePodPhoto, type PickedPhoto } from "../lib/photo";
import { EXCEPTION_CATEGORIES, validateExceptionForm } from "../lib/exceptionForm";
import { useReportException } from "../hooks/useExceptionOutbox";
import { apiErrorMessage } from "../services/api";

interface StopOption {
  id: string;
  label: string;
}

/**
 * Driver "Report Exception" form (modal). Category (5 confirmed) + optional stop
 * + required reason + required photo. GPS + client timestamp are captured
 * automatically inside useReportException; the driver cannot pick a server time.
 * The driver can ONLY report — no verify/reject/resume/retry/resolution here.
 */
export function ReportExceptionSheet({
  visible,
  tripId,
  stops,
  onClose,
}: {
  visible: boolean;
  tripId: string;
  stops: StopOption[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const report = useReportException();

  const [category, setCategory] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCategory(null); setStopId(null); setReason(""); setPhoto(null); setSubmitting(false);
  };
  const close = () => { reset(); onClose(); };

  const onCapture = async () => {
    const res = await capturePodPhoto();
    if (res === "permission_denied") { toast(t("exception.photoPermissionDenied"), "error"); return; }
    if (res) setPhoto(res);
  };

  const onSubmit = async () => {
    const err = validateExceptionForm({ category, reason, photo });
    if (err) { toast(t(err), "error"); return; }
    setSubmitting(true);
    try {
      const created = await report({ tripId, category: category!, reason: reason.trim(), tripStopId: stopId, photo: photo! });
      toast(created ? t("exception.reportedToast") : t("exception.queuedToast"), "success");
      close();
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.reportFailed")), "error");
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{t("exception.reportTitle")}</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>{t("exception.categoryLabel")}</Text>
            <View style={styles.chips}>
              {EXCEPTION_CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c.key}
                  onPress={() => setCategory(c.key)}
                  style={[styles.chip, category === c.key && styles.chipOn]}
                >
                  <Text style={[styles.chipText, category === c.key && styles.chipTextOn]}>{t(c.i18nKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {stops.length > 1 && (
              <>
                <Text style={styles.label}>{t("exception.stopLabel")}</Text>
                <View style={styles.chips}>
                  {stops.map((s) => (
                    <TouchableOpacity key={s.id} onPress={() => setStopId(stopId === s.id ? null : s.id)} style={[styles.chip, stopId === s.id && styles.chipOn]}>
                      <Text style={[styles.chipText, stopId === s.id && styles.chipTextOn]}>{s.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.label}>{t("exception.reasonLabel")}</Text>
            <TextInput
              style={styles.input}
              value={reason}
              onChangeText={setReason}
              placeholder={t("exception.reasonPlaceholder")}
              multiline
              maxLength={2000}
            />

            <Text style={styles.label}>{t("exception.photoLabel")}</Text>
            {photo ? (
              <TouchableOpacity onPress={onCapture}><Image source={{ uri: photo.uri }} style={styles.preview} /></TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={onCapture} style={styles.photoBtn}>
                <Text style={styles.photoBtnText}>{t("exception.capturePhoto")}</Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <Button variant="outline" title={t("common.cancel")} onPress={close} />
            <View style={{ width: spacing.sm }} />
            {submitting ? <ActivityIndicator color={colors.blue} /> : <Button title={t("exception.submit")} onPress={onSubmit} />}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: { backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, maxHeight: "88%" },
  title: { fontSize: 18, fontWeight: "700", color: colors.text, marginBottom: spacing.md },
  label: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginTop: spacing.md, marginBottom: spacing.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  chipOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  chipText: { color: colors.text, fontSize: 13 },
  chipTextOn: { color: "#fff", fontWeight: "600" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 72, textAlignVertical: "top", color: colors.text },
  photoBtn: { borderWidth: 1, borderColor: colors.blue, borderRadius: radius.md, padding: spacing.md, alignItems: "center" },
  photoBtnText: { color: colors.blue, fontWeight: "600" },
  preview: { width: "100%", height: 180, borderRadius: radius.md, resizeMode: "cover" },
  actions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", marginTop: spacing.md },
});
