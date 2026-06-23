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
import { colors, radius } from "../theme";

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

// Bordered text input with an optional leading icon.
export function TextField({
  label,
  leftIcon,
  rightElement,
  ...rest
}: TextInputProps & {
  label?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightElement?: React.ReactNode;
}) {
  return (
    <View style={styles.block}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      <View style={styles.inputRow}>
        {leftIcon ? (
          <Ionicons name={leftIcon} size={18} color={colors.textFaint} style={styles.leftIcon} />
        ) : null}
        <TextInput
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          {...rest}
        />
        {rightElement}
      </View>
    </View>
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
    fontSize: 13,
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
  leftIcon: { marginRight: 10 },
  input: { flex: 1, fontSize: 15, color: colors.navy, paddingVertical: 14 },
  value: { flex: 1, fontSize: 15, color: colors.navy, fontWeight: "600" },
});
