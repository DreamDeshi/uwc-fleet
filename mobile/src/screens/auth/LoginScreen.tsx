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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { AuthStackParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../services/api";
import { colors, layout, radius, shadow } from "../../theme";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/Button";

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();

  const [localPhone, setLocalPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Presentation-only: which field wears the corporate-blue focus ring.
  const [focused, setFocused] = useState<"phone" | "pw" | null>(null);

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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.flexGrow} keyboardShouldPersistTaps="handled">
        {/* Blue brand header — decorative discs bleed off the corner (the
            admin KPI-tile depth cue), yellow underline closes it. */}
        <View style={[styles.header, { paddingTop: insets.top + 28 }]}>
          <View style={styles.discBig} pointerEvents="none" />
          <View style={styles.discSmall} pointerEvents="none" />
          <View>
            <Text style={styles.welcome}>{t("login.welcome")}</Text>
            <Text style={styles.subtitle}>{t("login.subtitle")}</Text>
          </View>
        </View>

        {/* Form panel rises into the header with rounded shoulders. */}
        <View style={styles.form}>
          {/* Company logo — on the white card, where the blue+yellow mark reads
              cleanly (it disappears on the blue header). Largest instance. */}
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <BrandLogo height={92} />
          </View>
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

          <Text style={styles.footer}>{t("login.footer")}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.blue },
  flexGrow: { flexGrow: 1 },
  header: {
    backgroundColor: colors.blue,
    paddingHorizontal: 24,
    paddingBottom: 56,
    overflow: "hidden",
  },
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
  welcome: { color: colors.white, fontSize: 26, fontWeight: "800" },
  subtitle: { color: "rgba(255,255,255,0.7)", fontSize: 15, marginTop: 4 },
  form: {
    flex: 1,
    padding: 24,
    paddingTop: 28,
    marginTop: -24,
    backgroundColor: colors.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    // Desktop: the form becomes a centred card instead of a full-width sheet.
    width: "100%",
    maxWidth: layout.auth,
    alignSelf: "center",
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
  footer: { marginTop: "auto", paddingTop: 28, textAlign: "center", color: colors.textFaint, fontSize: 13 },
});
