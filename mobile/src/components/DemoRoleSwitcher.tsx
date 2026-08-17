import React, { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext";
import { apiErrorMessage } from "../services/api";
import { colors, radius } from "../theme";
import { DemoRole, demoAccounts, demoPassword } from "../lib/demoLogin";

/**
 * One-tap role entry for the SDG demo instance — see `lib/demoLogin.ts` for the
 * gate. This component renders NOTHING unless that gate is open, so the login
 * screen can mount it unconditionally and production still shows a plain form.
 *
 * It signs in through the SAME `login()` the form uses: the demo accounts are
 * ordinary users on the demo database, not a bypass. There is no alternate
 * auth path to get wrong, and nothing here weakens the real one.
 */
export function DemoRoleSwitcher({ style }: { style?: ViewStyle }) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const accounts = demoAccounts();

  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Gate shut → no list → no panel. Production returns here.
  if (accounts.length === 0) return null;

  const enter = async (role: DemoRole, phone: string) => {
    const password = demoPassword();
    if (!password || busy) return;
    setError(null);
    setBusy(role);
    try {
      await login(phone, password);
      // On success RootNavigator swaps to that role's tabs, unmounting this.
    } catch (err) {
      setError(apiErrorMessage(err, t("common.errorGeneric")));
    } finally {
      setBusy(null);
    }
  };

  const ICONS: Record<DemoRole, keyof typeof Ionicons.glyphMap> = {
    admin: "shield-checkmark",
    driver: "car",
    requestor: "clipboard",
  };

  return (
    <View style={[styles.panel, style]}>
      <View style={styles.headRow}>
        <Ionicons name="flash" size={16} color={colors.blue} />
        <Text style={styles.title}>{t("login.demo.title")}</Text>
      </View>
      <Text style={styles.subtitle}>{t("login.demo.subtitle")}</Text>

      <View style={styles.buttons}>
        {accounts.map((a) => (
          <TouchableOpacity
            key={a.role}
            onPress={() => enter(a.role, a.phone)}
            disabled={busy !== null}
            activeOpacity={0.85}
            style={[styles.button, busy !== null && busy !== a.role && styles.buttonDim]}
          >
            {busy === a.role ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <Ionicons name={ICONS[a.role]} size={18} color={colors.white} />
                <Text style={styles.buttonLabel}>{t(`login.demo.${a.role}`)}</Text>
              </>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* ⚠ THE DISCLOSURE, and it belongs BELOW the buttons on purpose.
          Judges reach this screen by QR from a public poster with no context,
          and the next thing they do is read delivery records and pay figures.
          Nothing else on the screen says those are invented. It sits under the
          buttons rather than above them because it explains what they are about
          to see, not what they are about to press.

          It needs no gate of its own: `accounts.length === 0` returns null
          above, so the whole panel — this line included — cannot render on a
          build without the demo env. Production never reaches here. */}
      <Text style={styles.sampleData}>{t("login.demo.sampleData")}</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>{t("login.demo.or")}</Text>
        <View style={styles.dividerLine} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.tintBlue,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginTop: 28,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: {
    fontSize: 13,
    fontWeight: "800",
    color: colors.navy,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 4, lineHeight: 18 },
  buttons: { marginTop: 12, gap: 8 },
  sampleData: { fontSize: 12, color: colors.textMuted, marginTop: 10, lineHeight: 16, textAlign: "center" },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.blue,
    paddingHorizontal: 14,
  },
  buttonDim: { opacity: 0.5 },
  buttonLabel: { color: colors.white, fontSize: 15, fontWeight: "700" },
  error: { marginTop: 10, color: colors.red, fontSize: 13, fontWeight: "600" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: {
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
});
