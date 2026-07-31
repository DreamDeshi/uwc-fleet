import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { capturePodPhoto, type PickedPhoto } from "../lib/photo";
import { PhotoReviewModal } from "./PhotoReviewModal";
import { EXCEPTION_CATEGORIES, CANNED_REASONS, validateExceptionForm } from "../lib/exceptionForm";
import { useReportException } from "../hooks/useExceptionOutbox";
import { apiErrorMessage } from "../services/api";

interface StopOption {
  id: string;
  label: string;
}

const CATEGORY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  customer_site: "business-outline",
  truck: "car-outline",
  cargo: "cube-outline",
  external: "rainy-outline",
  documentation: "document-text-outline",
};

/**
 * "What went wrong?" — the driver's delivery-exception report, rebuilt to the
 * approved design (frame 19).
 *
 * The old form asked a driver standing at a locked gate to type a sentence.
 * Now: five category TILES, four canned phrases one tap each, an optional note
 * for anything else, and the photo. The phrases fill the note rather than
 * replacing it, so he can tap "Gate locked" and still add "back entrance too".
 *
 * The driver can ONLY report. No verify / reject / resume / retry here — GPS
 * and the client timestamp attach automatically inside useReportException, and
 * the footnote says so, because a driver who does not know that will type the
 * time and place into the note.
 */
export function ReportExceptionSheet({
  visible,
  tripId,
  stops,
  activeStopId,
  onClose,
}: {
  visible: boolean;
  tripId: string;
  stops: StopOption[];
  /** The stop he is standing at — pre-selected, so the common case is no choice. */
  activeStopId?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const report = useReportException();

  const [category, setCategory] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(activeStopId ?? null);
  const [reason, setReason] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  // Frame 20 of the design pack: the shot goes to a full-screen review BEFORE it
  // becomes the report's photo. `review` holds a candidate that has not been
  // kept yet — keeping it is what sets `photo`.
  //
  // This is the step that catches a useless exception photo while the driver is
  // still AT the gate. Without it the office receives an unreadable shot, has to
  // request more evidence (frame 22), and the driver has already left.
  const [review, setReview] = useState<PickedPhoto | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the stop each time the sheet opens: the driver may have moved on
  // since it was last closed.
  React.useEffect(() => {
    if (visible) setStopId(activeStopId ?? null);
  }, [visible, activeStopId]);

  const reset = () => {
    setCategory(null);
    setStopId(activeStopId ?? null);
    setReason("");
    setPhoto(null);
    setReview(null);
    setSubmitting(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const onCapture = async () => {
    const res = await capturePodPhoto();
    if (res === "permission_denied") {
      toast(t("exception.photoPermissionDenied"), "error");
      return;
    }
    if (res) setReview(res);
  };

  // A canned phrase APPENDS to the note instead of overwriting it — tapping two
  // of them, or adding your own words after one, both have to work.
  const addPhrase = (phrase: string) => {
    setReason((cur) => {
      const trimmed = cur.trim();
      if (!trimmed) return phrase;
      if (trimmed.toLowerCase().includes(phrase.toLowerCase())) return cur;
      return `${trimmed}, ${phrase.toLowerCase()}`;
    });
  };

  const onSubmit = async () => {
    const err = validateExceptionForm({ category, reason, photo });
    if (err) {
      toast(t(err), "error");
      return;
    }
    setSubmitting(true);
    try {
      const created = await report({
        tripId,
        category: category!,
        reason: reason.trim(),
        tripStopId: stopId,
        photo: photo!,
      });
      toast(created ? t("exception.reportedToast") : t("exception.queuedToast"), "success");
      close();
    } catch (e) {
      toast(apiErrorMessage(e, t("exception.reportFailed")), "error");
      setSubmitting(false);
    }
  };

  const activeStopLabel = stops.find((s) => s.id === stopId)?.label;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title}>{t("exception.whatWentWrong")}</Text>
              {activeStopLabel ? (
                <Text style={styles.stopLine} numberOfLines={1}>{activeStopLabel}</Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={close} hitSlop={10} accessibilityLabel={t("common.cancel")}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
            {/* Category tiles */}
            <View style={styles.tiles}>
              {EXCEPTION_CATEGORIES.map((c) => {
                const on = category === c.key;
                return (
                  <TouchableOpacity
                    key={c.key}
                    onPress={() => setCategory(c.key)}
                    style={[styles.tile, on && styles.tileOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                  >
                    <Ionicons
                      name={CATEGORY_ICON[c.key] ?? "alert-circle-outline"}
                      size={20}
                      color={on ? colors.blue : colors.textMuted}
                    />
                    <Text style={[styles.tileText, on && styles.tileTextOn]} numberOfLines={2}>
                      {t(c.i18nKey)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Only ask WHICH stop when it is genuinely ambiguous. */}
            {stops.length > 1 && !activeStopId ? (
              <>
                <Text style={styles.label}>{t("exception.stopLabel")}</Text>
                <View style={styles.chips}>
                  {stops.map((s) => (
                    <TouchableOpacity
                      key={s.id}
                      onPress={() => setStopId(stopId === s.id ? null : s.id)}
                      style={[styles.chip, stopId === s.id && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, stopId === s.id && styles.chipTextOn]}>
                        {s.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={styles.label}>{t("exception.pickOrType")}</Text>
            <View style={styles.chips}>
              {CANNED_REASONS.map((r) => (
                <TouchableOpacity key={r.key} onPress={() => addPhrase(t(r.i18nKey))} style={styles.phrase}>
                  <Text style={styles.phraseText}>{t(r.i18nKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={styles.input}
              value={reason}
              onChangeText={setReason}
              placeholder={t("exception.notePlaceholderDriver")}
              placeholderTextColor={colors.textFaint}
              multiline
              maxLength={2000}
            />

            {photo ? (
              <View style={styles.photoWrap}>
                <Image source={{ uri: photo.uri }} style={styles.preview} />
                <TouchableOpacity onPress={onCapture} style={styles.retake}>
                  <Ionicons name="camera-outline" size={16} color={colors.blue} />
                  <Text style={styles.retakeText}>{t("trip.podRetake")}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={onCapture} style={styles.photoBtn}>
                <Ionicons name="camera-outline" size={20} color={colors.blue} />
                <Text style={styles.photoBtnText}>{t("exception.capturePhoto")}</Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          {/* Same viewer as the POD flow (design frame 20), with this flow's
              copy — the component defaults to the POD wording, so passing these
              three keys is the entire difference. Never uploads: keeping the
              photo just stages it for the submit below. */}
          <PhotoReviewModal
            photo={review}
            subtitle={activeStopLabel ?? t("exception.problemPhoto")}
            uploading={false}
            titleKey="trip.podReviewTitle"
            hintKeys={["exception.photoCheck1", "exception.photoCheck2", "exception.photoCheck3"]}
            confirmKey="exception.keepPhoto"
            onRetake={() => {
              setReview(null);
              void onCapture();
            }}
            onUse={() => {
              setPhoto(review);
              setReview(null);
            }}
            onCancel={() => setReview(null)}
          />

          <View style={styles.footer}>
            {submitting ? (
              <ActivityIndicator color={colors.blue} style={{ height: 56 }} />
            ) : (
              <Button title={t("exception.tellTheOffice")} onPress={onSubmit} size="xl" />
            )}
            {/* Say it plainly: otherwise the driver types the time and the
                place into the note as well. */}
            <View style={styles.autoRow}>
              <Ionicons name="location-outline" size={14} color={colors.textMuted} />
              <Text style={styles.autoText}>{t("exception.autoAttached")}</Text>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: 20,
    maxHeight: "92%",
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: "800", color: colors.navy },
  stopLine: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginTop: 3 },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    flexGrow: 1,
    flexBasis: "31%",
    minHeight: 72,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  tileOn: { borderColor: colors.blue, borderWidth: 2, backgroundColor: colors.tintBlue },
  tileText: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textAlign: "center" },
  tileTextOn: { color: colors.blue },

  label: { fontSize: 13, fontWeight: "700", color: colors.textMuted, marginTop: 18, marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  chipText: { color: colors.navy, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: colors.white, fontWeight: "700" },
  phrase: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.fieldBg,
  },
  phraseText: { color: colors.navy, fontSize: 13, fontWeight: "700" },

  input: {
    marginTop: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    minHeight: 84,
    textAlignVertical: "top",
    color: colors.navy,
    fontSize: 14,
    backgroundColor: colors.fieldBg,
  },

  photoWrap: { marginTop: 12 },
  preview: { width: "100%", height: 180, borderRadius: radius.md, resizeMode: "cover" },
  retake: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 8,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.blue,
  },
  retakeText: { color: colors.blue, fontSize: 14, fontWeight: "700" },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.blue,
  },
  photoBtnText: { color: colors.blue, fontSize: 15, fontWeight: "700" },

  footer: { marginTop: 16 },
  autoRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10 },
  autoText: { fontSize: 12, color: colors.textMuted, textAlign: "center" },
});
