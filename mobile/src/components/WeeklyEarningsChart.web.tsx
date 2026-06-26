import React from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../theme";

export type WeekDatum = { x: number; amount: number; label: string };

// Web fallback for the weekly earnings chart. victory-native draws through
// react-native-skia (CanvasKit/WASM), which does not bundle for a plain web
// export, so on web we render lightweight CSS-style bars with plain Views.
// Native keeps the Skia chart via WeeklyEarningsChart.tsx.
export function WeeklyEarningsChart({ data, weekMax }: { data: WeekDatum[]; weekMax: number }) {
  const max = weekMax * 1.25 || 1;
  return (
    <View style={styles.chartBox}>
      {data.map((d) => (
        <View key={d.x} style={styles.col}>
          <View
            style={[styles.bar, { height: `${Math.max((d.amount / max) * 100, 2)}%` }]}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chartBox: {
    height: 170,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 18,
    gap: 6,
  },
  col: { flex: 1, height: "100%", justifyContent: "flex-end" },
  bar: {
    width: "60%",
    alignSelf: "center",
    backgroundColor: colors.blue,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
  },
});
