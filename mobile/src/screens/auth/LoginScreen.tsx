import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { AuthStackParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../services/api";
import { colors, layout, radius, shadow } from "../../theme";
import { useWide } from "../../hooks/useWide";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/Button";
import { DemoRoleSwitcher } from "../../components/DemoRoleSwitcher";
import { ForgotPasswordModal } from "../../components/ForgotPasswordModal";

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  // Desktop browser (≥1024px) gets a designed two-column layout; phones keep the
  // stacked sheet below.
  const wide = useWide();

  const [localPhone, setLocalPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Presentation-only: which field wears the corporate-blue focus ring.
  const [focused, setFocused] = useState<"phone" | "pw" | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);

  const onSubmit = async () => {
    setError(null);
    const digits = localPhone.replace(/\D/g, "");
    if (!digits || !password) {
      setError(t("login.fillFields"));
      return;
    }
    setLoading(true);
    try {
      await login(`+60${digits}`, password);
      // On success the RootNavigator swaps to the role tabs automatically.
    } catch (err) {
      setError(apiErrorMessage(err, t("common.errorGeneric")));
    } finally {
      setLoading(false);
    }
  };

  // The form body — identical on phone and desktop.
  const fields = (
    <>
      <Text style={styles.label}>{t("login.phone")}</Text>
      <View style={[styles.phoneRow, focused === "phone" && styles.fieldFocused]}>
        <View style={styles.prefix}>
          <Text style={styles.flag}>🇲🇾</Text>
          <Text style={styles.prefixText}>+60</Text>
        </View>
        <TextInput
          value={localPhone}
          onChangeText={setLocalPhone}
          placeholder={t("login.phonePlaceholder")}
          placeholderTextColor={colors.textFaint}
          keyboardType="phone-pad"
          style={styles.phoneInput}
          onFocus={() => setFocused("phone")}
          onBlur={() => setFocused(null)}
        />
      </View>

      <Text style={[styles.label, { marginTop: 20 }]}>{t("login.password")}</Text>
      <View style={[styles.pwRow, focused === "pw" && styles.fieldFocused]}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.blue} style={{ marginRight: 10 }} />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder={t("login.passwordPlaceholder")}
          placeholderTextColor={colors.textFaint}
          secureTextEntry={!showPw}
          style={styles.pwInput}
          onFocus={() => setFocused("pw")}
          onBlur={() => setFocused(null)}
          onSubmitEditing={onSubmit}
        />
        <TouchableOpacity onPress={() => setShowPw((s) => !s)} hitSlop={10}>
          <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle" size={18} color={colors.red} />
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}

      <Button
        title={t("login.signIn")}
        onPress={onSubmit}
        loading={loading}
        size="xl"
        style={{ marginTop: 28 }}
        icon={<Ionicons name="arrow-forward" size={20} color={colors.white} />}
      />
      <Button
        title={t("login.createAccount")}
        onPress={() => navigation.navigate("Register")}
        variant="outline"
        style={{ marginTop: 12 }}
      />
      {/* Self-service password reset REQUEST (owner-approved design, 20 Aug
          2026): the driver picks their own new password here; an admin
          verifies identity and approves it. This replaced a dead end — a
          driver who forgot their password used to have no in-app path at
          all, only a sentence telling them to phone the office. */}
      <View style={styles.forgotRow}>
        <Text style={styles.forgotHint}>{t("login.forgotPasswordLead")}</Text>
        <TouchableOpacity onPress={() => setForgotOpen(true)} hitSlop={8}>
          <Text style={styles.forgotLink}>{t("login.forgotPasswordAction")}</Text>
        </TouchableOpacity>
      </View>
      <ForgotPasswordModal visible={forgotOpen} onClose={() => setForgotOpen(false)} />
    </>
  );

  // ── Desktop (≥1024): a two-column split — a blue brand panel carrying the
  //    logo + welcome, and a centred form card on a light field. ──
  if (wide) {
    return (
      <View style={styles.desktopRoot}>
        <LinearGradient colors={[colors.blueDark, colors.blue]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.brandPanel}>
          <View style={styles.discBig} pointerEvents="none" />
          <View style={styles.discSmall} pointerEvents="none" />
          <View style={{ maxWidth: 460 }}>
            <BrandLogo white height={120} />
            <Text style={styles.brandWelcome}>{t("login.welcome")}</Text>
            <Text style={styles.brandSubtitle}>{t("login.subtitle")}</Text>
            <Text style={styles.brandTagline}>{t("common.tagline")}</Text>
          </View>
        </LinearGradient>

        <View style={styles.formSide}>
          <View style={styles.desktopCard}>
            {/* Demo instance only — renders null everywhere else, gate in
                lib/demoLogin.ts. It sits ABOVE the form on purpose: a judge
                should never have to scroll past a keyboard to find it. */}
            <DemoRoleSwitcher style={{ marginTop: 0, marginBottom: 4 }} />
            {fields}
            <Text style={styles.footerDesktop}>{t("login.footer")}</Text>
          </View>
        </View>
      </View>
    );
  }

  // ── Phone: a LIGHT screen carrying the full-colour logo (admin design pack,
  //    frame 17 — owner ruling 9 Aug 2026).
  //
  //    ⚠ This REVERSES the 29 Jul ruling that put the WHITE logo on a blue
  //    panel. Both rulings are the owner's and this one is later; AGENTS.md has
  //    been updated in the same commit so the written rule and the screen agree
  //    — a stale "do not revert" note is worse than none, because the next
  //    person to read it would revert a deliberate decision.
  //
  //    The blue panel survives on DESKTOP above, where it is a brand column
  //    beside the form rather than a header above it.
  return (
    <KeyboardAvoidingView style={styles.phoneRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* Decorative only, and behind everything: pointerEvents="none" so the
          discs can never eat a tap meant for a field. */}
      <View style={styles.discTint} pointerEvents="none" />
      <View style={styles.discTintWarm} pointerEvents="none" />
      <ScrollView
        contentContainerStyle={[styles.phoneScroll, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        <BrandLogo height={84} style={styles.phoneLogo} />
        <Text style={styles.phoneWelcome}>{t("login.welcome")}</Text>
        <Text style={styles.phoneSubtitle}>{t("login.subtitle")}</Text>

        {/* Demo instance only — renders null everywhere else, gate in
            lib/demoLogin.ts. Above the form because the QR lands a judge here
            and the whole point is that they type nothing. The normal form is
            untouched below it. */}
        <DemoRoleSwitcher />

        <View style={styles.phoneFields}>{fields}</View>

        {/* The tagline reads as a footer rule here rather than a header line —
            two short yellow strokes either side, per the frame. */}
        <View style={styles.taglineRow}>
          <View style={styles.taglineDash} />
          <Text style={styles.taglineText}>{t("common.tagline")}</Text>
          <View style={styles.taglineDash} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  discBig: {
    position: "absolute",
    right: -70,
    top: -50,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  discSmall: {
    position: "absolute",
    right: 40,
    bottom: -60,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,204,0,0.10)",
  },
  // ── Phone (admin design pack, frame 17): a light screen, colour logo ──
  phoneRoot: { flex: 1, backgroundColor: colors.white, overflow: "hidden" },
  phoneScroll: { flexGrow: 1, paddingHorizontal: 28, width: "100%", maxWidth: layout.auth, alignSelf: "center" },
  // Solid pale tints, not translucent whites — the surface underneath is white
  // now, so a translucent disc would be invisible.
  discTint: { position: "absolute", right: -60, top: -60, width: 220, height: 220, borderRadius: 110, backgroundColor: colors.tintBlue },
  discTintWarm: { position: "absolute", left: -50, top: 220, width: 150, height: 150, borderRadius: 75, backgroundColor: colors.tintYellow },
  phoneLogo: { alignSelf: "center" },
  phoneWelcome: { fontSize: 24, fontWeight: "900", color: colors.navy, textAlign: "center", marginTop: 20, letterSpacing: -0.4 },
  phoneSubtitle: { fontSize: 14, color: colors.textMuted, textAlign: "center", marginTop: 5 },
  // `flex: 1` pushes the tagline to the bottom on a tall phone while letting the
  // fields grow past it on a short one (the scroll view keeps them reachable).
  phoneFields: { flex: 1, marginTop: 36 },
  taglineRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 22 },
  taglineDash: { width: 16, height: 2, borderRadius: 1, backgroundColor: colors.yellow },
  taglineText: { fontSize: 12, color: colors.textFaint, letterSpacing: 0.5, textTransform: "uppercase" },

  // ── Desktop split ──
  desktopRoot: { flex: 1, flexDirection: "row", backgroundColor: colors.bg },
  brandPanel: { flex: 1, overflow: "hidden", paddingHorizontal: 72, justifyContent: "center" },
  brandWelcome: { color: colors.white, fontSize: 44, fontWeight: "800", marginTop: 36, letterSpacing: -0.5 },
  brandSubtitle: { color: "rgba(255,255,255,0.78)", fontSize: 18, marginTop: 10 },
  brandTagline: { color: "rgba(255,255,255,0.5)", fontSize: 14, fontWeight: "600", letterSpacing: 0.5, marginTop: 28, textTransform: "uppercase" },
  formSide: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  desktopCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 40,
    ...shadow.card,
  },

  label: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.navy,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  phoneRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.fieldBg,
    overflow: "hidden",
  },
  prefix: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 15,
    borderRightWidth: 1.5,
    borderRightColor: colors.border,
    backgroundColor: colors.white,
  },
  flag: { fontSize: 18 },
  prefixText: { fontSize: 14, fontWeight: "600", color: colors.navy },
  phoneInput: { flex: 1, paddingHorizontal: 14, paddingVertical: 15, fontSize: 15, color: colors.navy },
  pwRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.fieldBg,
    paddingHorizontal: 14,
  },
  pwInput: { flex: 1, paddingVertical: 15, fontSize: 15, color: colors.navy },
  // Focused field wears the corporate-blue ring (the admin .uwc-input).
  fieldFocused: { borderColor: colors.blue, backgroundColor: colors.white },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.tintRed,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 14,
  },
  error: { flex: 1, color: colors.red, fontSize: 14, fontWeight: "600" },
  // Muted lead-in + a distinct blue action — small, so it doesn't compete
  // with Sign in / Create account, but the action itself is a real link now.
  forgotRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: 18, gap: 4 },
  forgotHint: { textAlign: "center", color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  forgotLink: { textAlign: "center", color: colors.blue, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  // Desktop card is content-height, so the footer sits just under the buttons.
  footerDesktop: { marginTop: 24, textAlign: "center", color: colors.textFaint, fontSize: 13 },
});
