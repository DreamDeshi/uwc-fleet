import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import { colors, radius } from "../theme";

type Variant = "primary" | "accent" | "success" | "outline" | "danger";

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
}

// Buttons are min 48dp tall for glove-friendly touch targets (UI brief).
export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  style,
}: Props) {
  const isDisabled = disabled || loading;
  const v = VARIANTS[variant];

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={[
        styles.base,
        { backgroundColor: v.bg, borderColor: v.border ?? v.bg, borderWidth: v.border ? 2 : 0 },
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <View style={styles.row}>
          {icon}
          <Text style={[styles.label, { color: v.fg }, icon ? { marginLeft: 8 } : null]}>
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: colors.blue, fg: colors.white },
  accent: { bg: colors.yellow, fg: colors.navy },
  success: { bg: colors.green, fg: colors.white },
  danger: { bg: colors.red, fg: colors.white },
  outline: { bg: colors.white, fg: colors.blue, border: colors.blue },
};

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  label: { fontSize: 16, fontWeight: "800" },
  disabled: { opacity: 0.5 },
});
