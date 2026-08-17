import React, { useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { colors, radius } from "../theme";

/**
 * The biometric opt-in, shared by every role's settings screen.
 *
 * ⚠ RENDERS NOTHING unless the build can actually do it: the flag is on, the
 * native modules are present, and the device has hardware with an OS enrolment.
 * On web `nativeModules()` returns null, so this disappears rather than
 * offering a switch that could never work — the "degrades cleanly" half of the
 * design lives here, and it is one condition, not a platform check scattered
 * through three screens.
 *
 * Turning it ON prompts immediately: enrolling without a prompt would store a
 * credential the device has never proved it can release.
 */
export function BiometricUnlockRow({ style }: { style?: object }) {
  const { t } = useTranslation();
  const { biometric } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!biometric.offerable) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      if (next) {
        const ok = await biometric.enrol();
        setFailed(!ok);
      } else {
        await biometric.disable();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.card, style]}>
      <View style={styles.row}>
        <Ionicons name="finger-print" size={19} color={colors.blue} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.label}>{t("unlock.settingTitle")}</Text>
          <Text style={styles.sub}>
            {biometric.enrolled ? t("unlock.settingOn") : t("unlock.settingOff")}
          </Text>
        </View>
        <Switch
          value={biometric.enrolled}
          onValueChange={toggle}
          disabled={busy}
          trackColor={{ true: colors.blue, false: colors.border }}
          accessibilityLabel={t("unlock.settingTitle")}
        />
      </View>
      {failed ? <Text style={styles.failed}>{t("unlock.enrolFailed")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { fontSize: 15, fontWeight: "700", color: colors.navy },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2, lineHeight: 18 },
  failed: { fontSize: 13, color: colors.red, fontWeight: "600", marginTop: 8 },
});
