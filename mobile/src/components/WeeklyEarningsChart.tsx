import React from "react";
import { StyleSheet, View } from "react-native";
import { CartesianChart, Bar } from "victory-native";
import { colors } from "../theme";

export type WeekDatum = { x: number; amount: number; label: string };

// Weekly earnings bar chart. Extracted from EarningsScreen so the web build can
// swap in a Skia-free fallback (WeeklyEarningsChart.web.tsx) — victory-native
// renders through @shopify/react-native-skia, which needs CanvasKit/WASM and
// does not bundle cleanly for a plain web export.
export function WeeklyEarningsChart({ data, weekMax }: { data: WeekDatum[]; weekMax: number }) {
  return (
    <View style={styles.chartBox}>
      <CartesianChart
        data={data}
        xKey="x"
        yKeys={["amount"]}
        domain={{ y: [0, weekMax * 1.25] }}
        domainPadding={{ left: 22, right: 22, top: 12 }}
      >
        {({ points, chartBounds }) => (
          <Bar
            points={points.amount}
            chartBounds={chartBounds}
            color={colors.blue}
            innerPadding={0.4}
            roundedCorners={{ topLeft: 6, topRight: 6 }}
          />
        )}
      </CartesianChart>
    </View>
  );
}

const styles = StyleSheet.create({
  chartBox: { height: 170 },
});
