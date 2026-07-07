import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { AuthStackParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { useDepartments } from "../../hooks/queries";
import { apiErrorMessage } from "../../services/api";
import { colors, radius } from "../../theme";
import { Button } from "../../components/Button";
import { TextField, PressableField } from "../../components/Field";
import { OptionsModal } from "../../components/OptionsModal";

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

export function RegisterScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { register } = useAuth();
  const { data: departments = [] } = useDepartments();

  const [step, setStep] = useState(0);
  const [role, setRole] = useState<"driver" | "requestor">("requestor");
  const [name, setName] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [departmentId, setDepartmentId] = useState<string | undefined>();
  const [localPhone, setLocalPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [deptOpen, setDeptOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const deptName = departments.find((d) => d.id === departmentId)?.name;

  const goNext = () => {
    setError(null);
    if (!name.trim()) return setError(t("register.nameRequired"));
    if (!employeeNumber.trim()) return setError(t("register.employeeRequired"));
    if (!departmentId) return setError(t("register.departmentRequired"));
    if (!localPhone.replace(/\D/g, "")) return setError(t("register.phoneRequired"));
    setStep(1);
  };

  const onSubmit = async () => {
    setError(null);
    if (password.length < 6) return setError(t("register.passwordTooShort"));
    if (password !== confirm) return setError(t("register.passwordMismatch"));
    setLoading(true);
    try {
      await register({
        phone: `+60${localPhone.replace(/\D/g, "")}`,
        password,
        name: name.trim(),
        employee_number: employeeNumber.trim(),
        department_id: departmentId,
        role,
      });
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, t("common.errorGeneric")));
    } finally {
      setLoading(false);
    }
  };

  // Success / pending-approval state replaces the form (no auto-login).
  if (done) {
    return (
      <View style={styles.successWrap}>
        <View style={styles.successIcon}>
          <Ionicons name="checkmark" size={40} color={colors.white} />
        </View>
        <Text style={styles.successTitle}>{t("register.successTitle")}</Text>
        <Text style={styles.successBody}>{t("register.pendingMessage")}</Text>
        <Button
          title={t("register.goToLogin")}
          onPress={() => navigation.navigate("Login")}
          style={{ marginTop: 28, alignSelf: "stretch" }}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity onPress={() => (step === 0 ? navigation.goBack() : setStep(0))} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.white} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t("register.title")}</Text>
        </View>
        <Text style={styles.headerSub}>{t("register.subtitle")}</Text>
      </View>

      {/* Progress */}
      <View style={styles.progressWrap}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressBar, { backgroundColor: colors.blue }]} />
          <View style={[styles.progressBar, { backgroundColor: step >= 1 ? colors.blue : colors.border }]} />
        </View>
        <Text style={styles.progressLabel}>
          {t("register.stepOf", { current: step + 1, total: 2 })} —{" "}
          {step === 0 ? t("register.stepPersonal") : t("register.stepPassword")}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 0 ? (
          <>
            {/* Role selector — required by the API (driver | requestor) */}
            <Text style={styles.roleLabel}>{t("register.iAmA")}</Text>
            <View style={styles.roleRow}>
              {(["requestor", "driver"] as const).map((r) => {
                const active = role === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.roleBtn, active && styles.roleBtnActive]}
                    onPress={() => setRole(r)}
                  >
                    <Ionicons
                      name={r === "driver" ? "car" : "cube"}
                      size={20}
                      color={active ? colors.blue : colors.textFaint}
                    />
                    <Text style={[styles.roleText, active && { color: colors.blue }]}>
                      {r === "driver" ? t("register.roleDriver") : t("register.roleRequestor")}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TextField
              label={t("register.fullName")}
              leftIcon="person-outline"
              value={name}
              onChangeText={setName}
              placeholder={t("register.fullNamePlaceholder")}
            />
            <TextField
              label={t("register.employeeNumber")}
              leftIcon="id-card-outline"
              value={employeeNumber}
              onChangeText={setEmployeeNumber}
              placeholder={t("register.employeeNumberPlaceholder")}
              autoCapitalize="characters"
            />
            <PressableField
              label={t("register.department")}
              leftIcon="business-outline"
              value={deptName}
              placeholder={t("register.departmentPlaceholder")}
              onPress={() => setDeptOpen(true)}
            />
            <TextField
              label={t("register.phone")}
              leftIcon="call-outline"
              value={localPhone}
              onChangeText={setLocalPhone}
              placeholder={t("register.phonePlaceholder")}
              keyboardType="phone-pad"
            />

            <View style={styles.notice}>
              <Ionicons name="information-circle-outline" size={18} color={colors.blue} />
              <Text style={styles.noticeText}>{t("register.verifyNotice")}</Text>
            </View>
          </>
        ) : (
          <>
            <TextField
              label={t("register.password")}
              leftIcon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              placeholder={t("register.passwordPlaceholder")}
              secureTextEntry
            />
            <TextField
              label={t("register.confirmPassword")}
              leftIcon="lock-closed-outline"
              value={confirm}
              onChangeText={setConfirm}
              placeholder={t("register.confirmPlaceholder")}
              secureTextEntry
            />

            {/* Summary */}
            <View style={styles.summary}>
              {[
                [t("register.fullName"), name || "—"],
                [t("register.employeeNumber"), employeeNumber || "—"],
                [t("register.department"), deptName || "—"],
                [t("register.iAmA"), role === "driver" ? t("register.roleDriver") : t("register.roleRequestor")],
              ].map(([k, v]) => (
                <View key={k} style={styles.summaryRow}>
                  <Text style={styles.summaryKey}>{k}</Text>
                  <Text style={styles.summaryVal}>{v}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* Bottom actions */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {step === 0 ? (
          <Button title={t("common.next")} onPress={goNext} icon={<Ionicons name="arrow-forward" size={18} color={colors.white} />} />
        ) : (
          <Button
            title={t("register.create")}
            onPress={onSubmit}
            loading={loading}
            variant="accent"
            icon={<Ionicons name="checkmark" size={18} color={colors.navy} />}
          />
        )}
        <View style={styles.loginLinkRow}>
          <Text style={styles.loginLinkText}>{t("register.haveAccount")} </Text>
          <TouchableOpacity onPress={() => navigation.navigate("Login")}>
            <Text style={styles.loginLink}>{t("login.signIn")}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <OptionsModal
        visible={deptOpen}
        title={t("register.department")}
        options={departments.map((d) => ({ label: d.name, value: d.id }))}
        selectedValue={departmentId}
        onSelect={setDepartmentId}
        onClose={() => setDeptOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 20 },
  headerTitle: { color: colors.white, fontSize: 20, fontWeight: "800" },
  headerSub: { color: "rgba(255,255,255,0.6)", fontSize: 14, marginTop: 8 },
  progressWrap: { paddingHorizontal: 20, paddingTop: 16 },
  progressTrack: { flexDirection: "row", gap: 6 },
  progressBar: { flex: 1, height: 4, borderRadius: 2 },
  progressLabel: { fontSize: 13, color: "#888", fontWeight: "600", marginTop: 6 },
  body: { padding: 20, paddingBottom: 32 },
  roleLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.navy,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  roleRow: { flexDirection: "row", gap: 10, marginBottom: 16 },
  roleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  roleBtnActive: { borderColor: colors.blue, backgroundColor: colors.tintBlue, borderWidth: 2 },
  roleText: { fontSize: 14, fontWeight: "700", color: colors.textFaint },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.tintBlue,
    borderRadius: radius.md,
    padding: 12,
  },
  noticeText: { flex: 1, fontSize: 13, color: colors.blue, fontWeight: "600" },
  summary: { backgroundColor: "#f8f9fc", borderRadius: radius.md, padding: 16, marginTop: 4 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  summaryKey: { fontSize: 14, color: "#888" },
  summaryVal: { fontSize: 14, fontWeight: "600", color: colors.navy },
  error: { color: colors.red, fontSize: 14, marginTop: 16, fontWeight: "600" },
  bottom: {
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  loginLinkRow: { flexDirection: "row", justifyContent: "center", marginTop: 14 },
  loginLinkText: { fontSize: 14, color: "#888" },
  loginLink: { fontSize: 14, fontWeight: "700", color: colors.blue },
  successWrap: { flex: 1, backgroundColor: colors.white, alignItems: "center", justifyContent: "center", padding: 32 },
  successIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  successTitle: { fontSize: 22, fontWeight: "800", color: colors.navy, marginBottom: 10 },
  successBody: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 21 },
});
