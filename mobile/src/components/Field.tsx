import React from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

// Bordered text input with an optional leading icon. The row wears a
// corporate-blue ring while focused (presentation-only state; any caller
// onFocus/onBlur handlers still run).
export function TextField({
  label,
  leftIcon,
  rightElement,
  onFocus,
  onBlur,
  ...rest
}: TextInputProps & {
  label?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightElement?: React.ReactNode;
}) {
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={styles.block}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <View style={[styles.inputRow, focused && styles.inputRowFocused]}>
        {leftIcon ? (
          <Ionicons
            name={leftIcon}
            size={18}
            color={focused ? colors.blue : colors.textFaint}
            style={styles.leftIcon}
          />
        ) : null}
        <TextInput
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
        {rightElement}
      </View>
    </View>
  );
}

// Password input with the same show/hide eye the login screen has. Typing a
// password blind — twice, for confirm fields — is error-prone for non-technical
// users (owner, 27 Jul 2026), so every password field shares this toggle.
export function PasswordField({
  label,
  leftIcon = "lock-closed-outline",
  ...rest
}: TextInputProps & {
  label?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  return (
    <TextField
      label={label}
      leftIcon={leftIcon}
      autoCapitalize="none"
      {...rest}
      secureTextEntry={!visible}
      rightElement={
        <TouchableOpacity
          onPress={() => setVisible((v) => !v)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t(visible ? "common.hidePassword" : "common.showPassword")}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={20}
            color={colors.textMuted}
          />
        </TouchableOpacity>
      }
    />
  );
}

// A pressable "select"/date field showing a value + chevron.
export function PressableField({
  label,
  value,
  placeholder,
  onPress,
  leftIcon,
}: {
  label?: string;
  value?: string;
  placeholder?: string;
  onPress: () => void;
  leftIcon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.block}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <TouchableOpacity style={styles.inputRow} onPress={onPress} activeOpacity={0.7}>
        {leftIcon ? (
          <Ionicons name={leftIcon} size={18} color={colors.textFaint} style={styles.leftIcon} />
        ) : null}
        <Text style={[styles.value, !value && { color: colors.textFaint, fontWeight: "400" }]}>
          {value || placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 16 },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.navy,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  inputRowFocused: { borderColor: colors.blue },
  leftIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, color: colors.navy, paddingVertical: 14 },
  value: { flex: 1, fontSize: 15, color: colors.navy, fontWeight: "600" },
});
