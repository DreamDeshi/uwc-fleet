import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";

// The blue-dot → yellow-line → red-pin vertical route used across trip cards.
export function RouteLine({
  from,
  to,
  fromLabel,
  toLabel,
}: {
  from: string;
  to: string;
  fromLabel?: string;
  toLabel?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View style={styles.dot} />
        <View style={styles.line} />
        <Ionicons name="location" size={16} color={colors.red} />
      </View>
      <View style={{ flex: 1 }}>
        {fromLabel ? <Text style={styles.smallLabel}>{fromLabel}</Text> : null}
        <Text style={styles.place}>{from}</Text>
        <View style={{ height: 16 }} />
        {toLabel ? <Text style={styles.smallLabel}>{toLabel}</Text> : null}
        <Text style={styles.place}>{to}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "stretch", gap: 14 },
  rail: { alignItems: "center", width: 16 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.blue, marginTop: 3 },
  line: { width: 2, flex: 1, backgroundColor: colors.yellow, minHeight: 28, marginVertical: 2 },
  smallLabel: {
    fontSize: 11,
    color: colors.textFaint,
    fontWeight: "600",
    marginBottom: 2,
    textTransform: "uppercase",
  },
  place: { fontSize: 15, fontWeight: "700", color: colors.navy },
});
