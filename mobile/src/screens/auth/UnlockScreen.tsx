import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import { colors, layout, radius } from "../../theme";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/Button";
import { unlockFailureKey, type UnlockFailure } from "../../lib/biometricUnlock";

/**
 * THE LOCK SCREEN — shown when tokens exist and this device is enrolled.
 *
 * It prompts once on mount, because a lock screen whose only content is a button
 * that opens the prompt makes every launch two taps instead of none. If that
 * first prompt is cancelled the button is there to try again.
 *
 * ⚠ EVERY FAILURE NAMES ITSELF. The failure mode this design exists to avoid is
 * "my fingerprint worked and the app threw me out with no explanation" — so
 * there is no generic message here. `session_rejected` in particular says the
 * likely cause out loud (signed in on another phone) AND its consequence
 * (pushes now go to that phone), because a driver who does not know that will
 * wait for a notification that is never coming.
 */
export function UnlockScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { biometric } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<UnlockFailure | null>(null);

  const attempt = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await biometric.unlock();
      if (result) setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  // Prompt as the screen appears — one launch, one gesture.
  useEffect(() => {
    void attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A rejected session has already been un-enrolled by the context, so the only
  // way forward is the password. Say so instead of offering a dead retry.
  const terminal = failure === "session_rejected" || failure === "unavailable";

  return (
    <View style={[styles.root, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.card}>
        <BrandLogo height={64} style={{ alignSelf: "center" }} />
        <View style={styles.iconRing}>
          <Ionicons name="finger-print" size={34} color={colors.blue} />
        </View>
        <Text style={styles.title}>{t("unlock.title")}</Text>
        <Text style={styles.body}>{t("unlock.body")}</Text>

        {failure ? (
          <View style={styles.failureBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.failureText}>{t(unlockFailureKey(failure))}</Text>
          </View>
        ) : null}

        {terminal ? null : (
          <Button
            title={t("unlock.retry")}
            onPress={attempt}
            loading={busy}
            size="xl"
            style={{ marginTop: 24 }}
            icon={<Ionicons name="finger-print" size={20} color={colors.white} />}
          />
        )}
        <Button
          title={t("unlock.usePassword")}
          onPress={biometric.usePassword}
          variant="outline"
          style={{ marginTop: 12 }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.white,
    paddingHorizontal: 28,
    justifyContent: "center",
  },
  card: { width: "100%", maxWidth: layout.auth, alignSelf: "center" },
  iconRing: {
    alignSelf: "center",
    marginTop: 28,
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.tintBlue,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "900",
    color: colors.navy,
    textAlign: "center",
    marginTop: 18,
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },
  failureBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: colors.tintRed,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 18,
  },
  failureText: { flex: 1, color: colors.red, fontSize: 13.5, fontWeight: "600", lineHeight: 19 },
});

/** Web never reaches this screen — see `nativeModules()`. Kept as a guard. */
export const UNLOCK_SUPPORTED = Platform.OS !== "web";
