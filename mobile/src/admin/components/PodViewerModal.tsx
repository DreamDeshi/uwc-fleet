// POD viewer — frame 16 of the admin design pack.
//
// WHY THIS EXISTS: every POD used to open with `Linking.openURL(pod_photo)`,
// which hands the admin to the OS browser and LEAVES THE APP. Coming back means
// a task-switch, and on Android it can drop the admin on a blank tab when the
// signed URL has expired. The photo is evidence attached to a stop; it belongs
// beside the stop.
//
// ⚠ POD PHOTOS ONLY. K2 documents and trip attachments keep `Linking.openURL`
// deliberately — a K2 may be a MULTI-PAGE PDF and its signed URL carries no
// extension to say so, and IncentiveApprovalsScreen has carried a standing
// warning about exactly this: rendering one as an <Image> shows a blank box for
// a PDF, and a page-1 raster preview is worse, because it looks complete while
// hiding pages. Those go to the system viewer whole.
//
// ⚠ DOWNLOAD AND SHARE ARE WEB-ONLY, and that is a shipping constraint, not a
// design choice. Mr Teh cleared the permanent-copy policy (9 Aug 2026), but a
// native share sheet needs expo-sharing — a NEW NATIVE DEPENDENCY, so an APK
// rebuild, so not an OTA. Both buttons are therefore gated on
// Platform.OS === "web", exactly as the Reports and Sustainability CSV exports
// are, and platform/podFile.ts stubs the native side until that rebuild.
// A phone admin does NOT see these buttons yet.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";
import { formatDateTime, formatTime } from "../lib/format";
import { podInitialState, podViewerReducer, type PodState } from "../lib/podViewer";
import { canSharePod, downloadPod, sharePod } from "../platform/podFile";

export function PodViewerModal({
  visible,
  onClose,
  photoUrl,
  ticket,
  sequence,
  consignee,
  uploadedAt,
  deliveredAt,
  onStale,
}: {
  visible: boolean;
  onClose: () => void;
  /** Freshly-signed POD URL. Changes identity when the owner re-signs it. */
  photoUrl: string;
  ticket: string;
  sequence: number;
  consignee: string;
  uploadedAt?: string | null;
  deliveredAt?: string | null;
  /**
   * Re-fetch whatever query produced `photoUrl`, so the server mints a new
   * signature. Resolves once the refetch has settled; the caller is expected to
   * re-render this modal with the new URL.
   */
  onStale: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // Every transition goes through lib/podViewer, which is where the expiry
  // rules are specified and tested — including the one that would otherwise
  // hang this modal (a refetch that returns the same dead URL).
  const [state, setState] = useState<PodState>(podInitialState);
  const stateRef = useRef<PodState>(podInitialState);
  const apply = useCallback(
    (event: Parameters<typeof podViewerReducer>[1]) => {
      const { state: next, refresh } = podViewerReducer(stateRef.current, event);
      stateRef.current = next;
      setState(next);
      if (refresh) {
        // A rejected refetch leaves the URL untouched, so no further error can
        // fire — resolve it here rather than waiting on one.
        void Promise.resolve(onStale()).catch(() => {
          const failed: PodState = { ...stateRef.current, status: "failed" };
          stateRef.current = failed;
          setState(failed);
        });
      }
    },
    [onStale]
  );

  useEffect(() => {
    apply({ type: "url", url: photoUrl });
  }, [photoUrl, apply]);

  const status = state.status;
  const handleError = useCallback(() => apply({ type: "error", url: photoUrl }), [apply, photoUrl]);
  const retry = useCallback(() => apply({ type: "retry" }), [apply]);

  const [busy, setBusy] = useState<null | "download" | "share">(null);
  const [actionError, setActionError] = useState(false);
  // A POD filename should say WHICH delivery it proves, so a folder of them is
  // still readable a month later.
  const filename = `pod-${ticket}-stop${sequence}.jpg`;
  const canShare = Platform.OS === "web" && canSharePod();
  const showActions = Platform.OS === "web" && status === "ok";

  const run = useCallback(
    async (kind: "download" | "share", fn: () => Promise<void>) => {
      setActionError(false);
      setBusy(kind);
      try {
        await fn();
      } catch {
        // The commonest cause is the signature lapsing between opening the
        // modal and pressing the button, so say so rather than failing mutely.
        setActionError(true);
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const meta =
    uploadedAt && deliveredAt
      ? t("admin.pod.metaBoth", { uploaded: formatDateTime(uploadedAt), delivered: formatTime(deliveredAt) })
      : uploadedAt
        ? t("admin.pod.metaUploaded", { uploaded: formatDateTime(uploadedAt) })
        : deliveredAt
          ? t("admin.pod.metaDelivered", { delivered: formatDateTime(deliveredAt) })
          : null;

  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="fade" transparent={false}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            hitSlop={10}
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
          >
            <Ionicons name="close" size={20} color="#fff" />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>{t("admin.pod.title")}</Text>
            <Text numberOfLines={1} style={styles.subtitle}>
              {ticket} · {t("admin.pod.stop", { n: sequence })} · {consignee}
            </Text>
          </View>
        </View>

        <View style={styles.stage}>
          {/* Keyed on the URL so a fresh signature remounts the <Image> and
              retries the load; without the key React reuses the failed node. */}
          <Image
            key={photoUrl}
            source={{ uri: photoUrl }}
            style={styles.photo}
            resizeMode="contain"
            onLoad={() => apply({ type: "loaded" })}
            onError={handleError}
            accessibilityLabel={t("admin.pod.title")}
          />
          {status !== "ok" && (
            <View style={styles.overlay} pointerEvents={status === "failed" ? "auto" : "none"}>
              {status === "failed" ? (
                <>
                  <Ionicons name="cloud-offline-outline" size={26} color="rgba(255,255,255,0.75)" />
                  <Text style={styles.overlayText}>{t("admin.pod.failed")}</Text>
                  <Pressable
                    onPress={retry}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
                  >
                    <Text style={styles.retryText}>{t("common.retry")}</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <ActivityIndicator color="#fff" />
                  {status === "refreshing" && <Text style={styles.overlayText}>{t("admin.pod.refreshing")}</Text>}
                </>
              )}
            </View>
          )}
        </View>

        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {actionError ? <Text style={styles.actionError}>{t("admin.pod.actionFailed")}</Text> : null}
        {showActions ? (
          <View style={styles.actions}>
            {canShare ? (
              <Pressable
                onPress={() => run("share", () => sharePod(photoUrl, filename))}
                disabled={busy !== null}
                accessibilityRole="button"
                style={({ pressed }) => [styles.action, styles.actionGhost, pressed && styles.actionGhostPressed, busy !== null && styles.actionDisabled]}
              >
                <Text style={styles.actionGhostText}>
                  {busy === "share" ? t("admin.pod.sharing") : t("admin.pod.share")}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => run("download", () => downloadPod(photoUrl, filename))}
              disabled={busy !== null}
              accessibilityRole="button"
              style={({ pressed }) => [styles.action, styles.actionPrimary, pressed && styles.actionPrimaryPressed, busy !== null && styles.actionDisabled]}
            >
              <Text style={styles.actionPrimaryText}>
                {busy === "download" ? t("admin.pod.downloading") : t("admin.pod.download")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.navyDeep, paddingHorizontal: 16, paddingTop: 44, paddingBottom: 24 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  close: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { backgroundColor: "rgba(255,255,255,0.24)" },
  title: { color: "#fff", fontSize: font.lg, fontWeight: "800" },
  subtitle: { color: "rgba(255,255,255,0.66)", fontSize: font.sm, marginTop: 2 },
  stage: { flex: 1, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.06)" },
  photo: { width: "100%", height: "100%" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  overlayText: { color: "rgba(255,255,255,0.8)", fontSize: font.sm, textAlign: "center" },
  retry: {
    marginTop: 4,
    borderRadius: radius.md,
    paddingVertical: 9,
    paddingHorizontal: 18,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  retryPressed: { backgroundColor: "rgba(255,255,255,0.26)" },
  retryText: { color: "#fff", fontSize: font.sm, fontWeight: "700" },
  meta: { color: "rgba(255,255,255,0.6)", fontSize: font.xs, marginTop: 14 },
  actionError: { color: "#FFB4AB", fontSize: font.xs, marginTop: 8 },
  actions: { flexDirection: "row", gap: 12, marginTop: 14 },
  action: { flex: 1, borderRadius: radius.md, paddingVertical: 13, alignItems: "center", justifyContent: "center" },
  actionDisabled: { opacity: 0.6 },
  actionGhost: { backgroundColor: "rgba(255,255,255,0.12)" },
  actionGhostPressed: { backgroundColor: "rgba(255,255,255,0.24)" },
  actionGhostText: { color: "#fff", fontSize: font.md, fontWeight: "700" },
  // Corporate yellow, as the frame draws the primary action.
  actionPrimary: { backgroundColor: colors.yellow },
  actionPrimaryPressed: { backgroundColor: "#E6B800" },
  actionPrimaryText: { color: colors.navy, fontSize: font.md, fontWeight: "800" },
});
