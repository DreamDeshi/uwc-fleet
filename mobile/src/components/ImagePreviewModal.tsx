// Full-screen, read-only image preview — "let me check what I attached"
// before it goes anywhere. No retake/use actions (see PhotoReviewModal for
// that flow); this is purely a viewer, close is the only action.
//
// ⚠ WHY THIS EXISTS RATHER THAN OPENING THE FILE EXTERNALLY: a picked image
// that has gone through client-side compression (imageCompress.web.ts) comes
// back as a `data:` URI, and Chromium (and most browsers) SILENTLY REFUSE to
// navigate a new tab/window to a `data:` URL — `window.open` neither throws
// nor opens anything. `Linking.openURL`/`Sharing.shareAsync` have no such
// restriction on native, but an in-app `<Image>` works identically for any
// uri scheme (data:/blob:/file:) on every platform, so it is the one approach
// that cannot silently do nothing. Found by actually clicking the row in a
// browser, not by reasoning about it — the PDF row (never compressed, always
// a blob: URL) opened fine while the image row did nothing, same handler.
import React from "react";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";

export function ImagePreviewModal({
  visible,
  uri,
  onClose,
}: {
  visible: boolean;
  /** Ignored while `visible` is false, so a stale uri can't flash on close. */
  uri: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="fade" transparent={false}>
      <View style={styles.root}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          hitSlop={10}
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
        >
          <Ionicons name="close" size={20} color="#fff" />
        </Pressable>
        {visible ? (
          <Image source={{ uri }} style={styles.photo} resizeMode="contain" />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.blueDark, paddingHorizontal: 16, paddingTop: 44, paddingBottom: 24 },
  close: {
    position: "absolute",
    top: 44,
    right: 16,
    zIndex: 1,
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { backgroundColor: "rgba(255,255,255,0.24)" },
  photo: { flex: 1, width: "100%" },
});
