// Full-screen POD photo review — step 3 of the agreed driver flow (design:
// `Driver Active Trip - Final Flow.dc.html`, screen 3). The in-app step between
// the OS camera and the upload: it exists to catch a bad chop-sign photo WHILE
// the driver is still standing at the consignee's counter, instead of the
// office rejecting the POD hours later.
//
// Exact values are taken from the design file, not guessed: dark chrome
// `blueDark` #001a4d, photo surface `navy` #1A1F5E, 62px actions at flex
// 1 : 1.3 (Retake outline / Use photo `blue`), hint ticks `green` 21px.
//
// The modal NEVER uploads — the parent owns the upload path (and its offline
// outbox fallback), so this stays pure presentation. Cancel returns with
// nothing, exactly like cancelling the camera.
import React from "react";
import { Image, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { colors, layout, radius, type } from "../theme";
import type { PickedPhoto } from "../lib/photo";

export function PodReviewModal({
  photo,
  subtitle,
  uploading,
  onRetake,
  onUse,
  onCancel,
}: {
  /** null = closed. */
  photo: PickedPhoto | null;
  /** "Stop 2 · SENTOSA PACKAGING SDN BHD" — which stop this photo is for. */
  subtitle: string;
  /** True while the parent's upload is in flight — locks both actions. */
  uploading: boolean;
  onRetake: () => void;
  onUse: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const hints = [t("trip.podCheck1"), t("trip.podCheck2"), t("trip.podCheck3")];

  return (
    <Modal visible={photo !== null} animationType="slide" onRequestClose={onCancel}>
      <View style={[styles.fill, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.inner}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.close}
              onPress={onCancel}
              disabled={uploading}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("common.cancel")}
            >
              <Ionicons name="close" size={22} color={colors.white} />
            </TouchableOpacity>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title}>{t("trip.podReviewTitle")}</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
          </View>

          {/* The photo — as large as the screen allows, letterboxed on navy. */}
          <View style={styles.body}>
            {photo ? (
              <Image source={{ uri: photo.uri }} style={styles.photo} resizeMode="contain" />
            ) : (
              <View style={styles.photo} />
            )}

            {/* Static quality hints — what the office rejects a POD for. */}
            <View style={styles.hints}>
              {hints.map((line) => (
                <View key={line} style={styles.hintRow}>
                  <Ionicons name="checkmark-circle" size={21} color={colors.green} />
                  <Text style={styles.hintText}>{line}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.action, styles.retake, uploading && styles.actionDisabled]}
              onPress={onRetake}
              disabled={uploading}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Ionicons name="camera-reverse" size={22} color={colors.white} />
              <Text style={styles.retakeLabel}>{t("trip.podRetakeShort")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.action, styles.use, uploading && styles.actionDisabled]}
              onPress={onUse}
              disabled={uploading}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Ionicons name="checkmark" size={24} color={colors.white} />
              <Text style={styles.useLabel}>{t("trip.podUse")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.blueDark },
  // Desktop web: cap + centre like every driver screen, so the photo doesn't
  // stretch across a 1440px monitor.
  inner: { flex: 1, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12 },
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.28)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: type.lg, fontWeight: "800", color: colors.white },
  subtitle: { fontSize: type.xs, color: "rgba(255,255,255,0.6)", marginTop: 1 },
  body: { flex: 1, paddingHorizontal: 16, justifyContent: "center", gap: 16 },
  photo: {
    flex: 1,
    width: "100%",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: colors.navy,
  },
  hints: { gap: 11, paddingHorizontal: 2 },
  hintRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  hintText: { flex: 1, fontSize: type.md, fontWeight: "700", color: colors.white },
  actions: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 14 },
  action: { minHeight: 62, borderRadius: radius.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  actionDisabled: { opacity: 0.5 },
  // 1 : 1.3 — "Use photo" is the primary without shouting.
  retake: { flex: 1, borderWidth: 2, borderColor: "rgba(255,255,255,0.4)" },
  retakeLabel: { fontSize: type.lg, fontWeight: "800", color: colors.white },
  use: {
    flex: 1.3,
    backgroundColor: colors.blue,
    shadowColor: colors.blue,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 6,
  },
  useLabel: { fontSize: 17, fontWeight: "800", color: colors.white },
});
