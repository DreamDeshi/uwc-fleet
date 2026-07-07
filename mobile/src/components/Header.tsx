import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";

// Corporate-blue header bar with white text (UI brief). Respects the top
// safe-area inset so it sits under the status bar / notch.
export function Header({
  title,
  onBack,
  right,
  subtitle,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
  subtitle?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      <View style={styles.row}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={styles.back} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color={colors.white} />
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.blue,
    paddingHorizontal: 20,
    paddingBottom: 18,
    // The admin header's signature corporate-yellow underline.
    borderBottomWidth: 4,
    borderBottomColor: colors.yellow,
  },
  row: { flexDirection: "row", alignItems: "center" },
  back: { marginRight: 8, marginLeft: -4 },
  title: { color: colors.white, fontSize: 20, fontWeight: "800" },
  subtitle: { color: "rgba(255,255,255,0.7)", fontSize: 14, marginTop: 2 },
});
