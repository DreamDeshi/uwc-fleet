// Reports charts — NATIVE build: lightweight View-based rendering (the
// same approach as WeeklyEarningsChart's web fallback, inverted — Skia
// charts are a mobile-pass decision). The web build resolves
// reportCharts.web.tsx with real recharts instead.
import React from "react";
import { Text, View } from "react-native";
import { colors, font, radius } from "../theme";
import type { MonthlyRow } from "../types";

export const PIE_COLORS = [colors.blue, colors.yellow, colors.green, colors.orange, "#9333ea", "#0891b2"];

export function IncentiveBarChart({ months }: { months: MonthlyRow[] }) {
  const max = Math.max(...months.map((m) => m.incentive), 1) * 1.15;
  return (
    <View style={{ height: 250, flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 8 }}>
      {months.map((m) => (
        <View key={m.month} style={{ flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
          <View
            style={{
              width: "62%",
              height: `${Math.max((m.incentive / max) * 100, 1)}%`,
              backgroundColor: colors.blue,
              borderTopLeftRadius: 6,
              borderTopRightRadius: 6,
            }}
          />
          <Text style={{ fontSize: font.xs, color: colors.textMuted }}>{m.label.split(" ")[0]}</Text>
        </View>
      ))}
    </View>
  );
}

// Native stand-in for the donut: proportion bars (the legend next to it
// already carries the counts; a real donut arrives with the mobile pass).
export function RouteSplitDonut({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <View style={{ width: "55%", justifyContent: "center", gap: 8 }}>
      {data.map((d, i) => (
        <View key={d.name} style={{ height: 12, backgroundColor: colors.divider, borderRadius: radius.pill, overflow: "hidden" }}>
          <View
            style={{
              width: `${(d.value / total) * 100}%`,
              height: "100%",
              backgroundColor: PIE_COLORS[i % PIE_COLORS.length],
              borderRadius: radius.pill,
            }}
          />
        </View>
      ))}
    </View>
  );
}
