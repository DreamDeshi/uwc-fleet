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
import { colors, radius, shadow } from "../../theme";
import { Logo } from "../../components/Logo";
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
        {/* Blue header */}
        <View style={[styles.header, { paddingTop: insets.top + 24 }]}>
          <Logo />
          <View style={{ marginTop: 24 }}>
            <Text style={styles.welcome}>{t("login.welcome")}</Text>
            <Text style={styles.subtitle}>{t("login.subtitle")}</Text>
          </View>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.label}>{t("login.phone")}</Text>
          <View style={styles.phoneRow}>
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
            />
          </View>

          <Text style={[styles.label, { marginTop: 20 }]}>{t("login.password")}</Text>
          <View style={styles.pwRow}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.blue} style={{ marginRight: 10 }} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={t("login.passwordPlaceholder")}
              placeholderTextColor={colors.textFaint}
              secureTextEntry={!showPw}
              style={styles.pwInput}
            />
            <TouchableOpacity onPress={() => setShowPw((s) => !s)} hitSlop={10}>
              <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            title={t("login.signIn")}
            onPress={onSubmit}
            loading={loading}
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
  flex: { flex: 1, backgroundColor: colors.white },
  flexGrow: { flexGrow: 1 },
  header: { backgroundColor: colors.blue, paddingHorizontal: 24, paddingBottom: 40 },
  welcome: { color: "rgba(255,255,255,0.95)", fontSize: 24, fontWeight: "700" },
  subtitle: { color: "rgba(255,255,255,0.55)", fontSize: 14, marginTop: 4 },
  form: { flex: 1, padding: 24 },
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
  error: { color: colors.red, fontSize: 14, marginTop: 14, fontWeight: "600" },
  footer: { marginTop: "auto", paddingTop: 28, textAlign: "center", color: "#bbb", fontSize: 13 },
});
