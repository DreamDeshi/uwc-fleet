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
import { colors, layout, radius } from "../../theme";
import { Button } from "../../components/Button";
import { PasswordField, PressableField, TextField } from "../../components/Field";
import { OptionsModal } from "../../components/OptionsModal";
import { isStrongPassword, PASSWORD_MIN_LENGTH } from "../../lib/passwordPolicy";

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
    // Mirrors the server floor (lib/passwordPolicy) — see the module header.
    if (!isStrongPassword(password)) return setError(t("common.passwordTooWeak"));
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

      {/* Numbered stepper (frame 03). The design's own step-2 frame still drew
          the old two-bar meter; the stepper is the stated intent ("Numbered
          stepper, two steps, no surprises"), so it runs on BOTH steps rather
          than swapping the progress control halfway through the form. */}
      <View style={styles.stepperWrap}>
        <View style={styles.stepper}>
          <StepDot n={1} active={step >= 0} />
          <Text style={[styles.stepLabel, step === 0 && styles.stepLabelActive]}>
            {t("register.stepPersonal")}
          </Text>
          <View style={styles.stepLine} />
          <StepDot n={2} active={step >= 1} />
          <Text style={[styles.stepLabel, step === 1 && styles.stepLabelActive]}>
            {t("register.stepPassword")}
          </Text>
        </View>
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
            <PasswordField
              label={t("register.password")}
              value={password}
              onChangeText={setPassword}
              // Interpolated from the CONSTANT, never a literal. All three
              // locales promised "minimum 6 characters" while the floor has
              // been 11 since 4 Aug 2026 — so the field told a new driver their
              // 6-character password was fine and the submit then rejected it.
              placeholder={t("register.passwordPlaceholder", { count: PASSWORD_MIN_LENGTH })}
            />
            <PasswordField
              label={t("register.confirmPassword")}
              value={confirm}
              onChangeText={setConfirm}
              placeholder={t("register.confirmPlaceholder")}
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

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.red} />
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom actions */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {step === 0 ? (
          <Button title={t("common.next")} onPress={goNext} size="xl" icon={<Ionicons name="arrow-forward" size={20} color={colors.white} />} />
        ) : (
          <Button
            title={t("register.create")}
            onPress={onSubmit}
            loading={loading}
            variant="accent"
            size="xl"
            icon={<Ionicons name="checkmark" size={20} color={colors.navy} />}
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

// One numbered circle in the stepper: filled blue once reached, hollow before.
function StepDot({ n, active }: { n: number; active: boolean }) {
  return (
    <View style={[styles.stepDot, active ? styles.stepDotActive : styles.stepDotIdle]}>
      <Text style={[styles.stepDotText, active && styles.stepDotTextActive]}>{n}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 20 },
  headerTitle: { color: colors.white, fontSize: 20, fontWeight: "800" },
  headerSub: { color: "rgba(255,255,255,0.7)", fontSize: 14, marginTop: 8 },
  stepperWrap: {
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: "100%",
    maxWidth: layout.content,
    alignSelf: "center",
  },
  stepDot: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  stepDotActive: { backgroundColor: colors.blue },
  stepDotIdle: { borderWidth: 2, borderColor: colors.border },
  stepDotText: { fontSize: 13, fontWeight: "800", color: colors.textFaint },
  stepDotTextActive: { color: colors.white },
  stepLine: { flex: 1, height: 2, backgroundColor: colors.border },
  stepLabel: { fontSize: 13, fontWeight: "700", color: colors.textFaint },
  stepLabelActive: { fontWeight: "800", color: colors.blue },
  body: { padding: 20, paddingBottom: 32, width: "100%", maxWidth: layout.content, alignSelf: "center" },
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
  summary: { backgroundColor: colors.fieldBg, borderRadius: radius.md, padding: 16, marginTop: 4 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  summaryKey: { fontSize: 14, color: colors.textMuted },
  summaryVal: { fontSize: 14, fontWeight: "600", color: colors.navy },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.tintRed,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 16,
  },
  error: { flex: 1, color: colors.red, fontSize: 14, fontWeight: "600" },
  bottom: {
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    width: "100%",
    maxWidth: layout.content,
    alignSelf: "center",
  },
  loginLinkRow: { flexDirection: "row", justifyContent: "center", marginTop: 14 },
  loginLinkText: { fontSize: 14, color: colors.textMuted },
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
