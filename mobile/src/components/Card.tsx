import React from "react";
import { StyleSheet, View, ViewStyle } from "react-native";
import { colors, radius, shadow } from "../theme";

export function Card({
  children,
  style,
  padded = true,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  padded?: boolean;
}) {
  return <View style={[styles.card, padded && styles.padded, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    // Hairline border for definition on white-ish backgrounds (admin cards).
    borderWidth: 1,
    borderColor: colors.borderLight,
    ...shadow.card,
  },
  padded: { padding: 16 },
});
