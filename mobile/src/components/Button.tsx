import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import { actionShadow, colors, radius } from "../theme";

type Variant = "primary" | "accent" | "success" | "outline" | "danger";
type Size = "md" | "xl";

interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
  /**
   * "xl" is the money-button tier — Start / Arrived / Delivered / POD capture
   * and the booking submit. Taller, bigger label, floats on a same-hue
   * shadow: impossible to fumble with gloves or in sunlight.
   */
  size?: Size;
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
  size = "md",
}: Props) {
  const isDisabled = disabled || loading;
  const v = VARIANTS[variant];
  const xl = size === "xl";

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
      style={[
        styles.base,
        xl && styles.xl,
        { backgroundColor: v.bg, borderColor: v.border ?? v.bg, borderWidth: v.border ? 2 : 0 },
        // Filled variants sit on a soft same-hue shadow (admin design
        // language); outline stays flat. Dropped while disabled so a dead
        // button doesn't look pressable.
        v.shadow && !isDisabled ? v.shadow : null,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <View style={styles.row}>
          {icon}
          <Text
            style={[
              styles.label,
              xl && styles.xlLabel,
              { color: v.fg },
              icon ? { marginLeft: 8 } : null,
            ]}
          >
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const VARIANTS: Record<
  Variant,
  { bg: string; fg: string; border?: string; shadow?: (typeof actionShadow)[keyof typeof actionShadow] }
> = {
  primary: { bg: colors.blue, fg: colors.white, shadow: actionShadow.blue },
  accent: { bg: colors.yellow, fg: colors.navy, shadow: actionShadow.yellow },
  success: { bg: colors.green, fg: colors.white, shadow: actionShadow.green },
  danger: { bg: colors.red, fg: colors.white, shadow: actionShadow.red },
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
  xl: {
    minHeight: 62,
    borderRadius: radius.lg,
    paddingHorizontal: 20,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  label: { fontSize: 16, fontWeight: "800" },
  xlLabel: { fontSize: 18, letterSpacing: 0.2 },
  disabled: { opacity: 0.5 },
});
