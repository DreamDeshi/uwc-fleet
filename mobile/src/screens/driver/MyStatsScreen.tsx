// "My Stats" — the merged driver self-view (owner ask, 2026-07-19): Earnings
// and My Score were two separate bottom tabs that both showed "RM earned this
// month", so they folded into one tab with a segmented [Earnings | Score]
// toggle. This drops the driver bar from 5 tabs to 4. Each segment renders the
// existing screen in `embedded` mode (its own <Header> suppressed) so the
// money/score logic is untouched — this is purely the shell around them.
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, layout, radius } from "../../theme";
import { Header } from "../../components/Header";
import { EarningsScreen } from "./EarningsScreen";
import { MyPerformanceScreen } from "./MyPerformanceScreen";

type Segment = "earnings" | "score";

export function MyStatsScreen() {
  const { t } = useTranslation();
  const [segment, setSegment] = useState<Segment>("earnings");

  const options: { value: Segment; label: string }[] = [
    { value: "earnings", label: t("myStats.earnings") },
    { value: "score", label: t("myStats.score") },
  ];

  return (
    <View style={styles.fill}>
      <Header title={t("myStats.title")} />
      <View style={styles.segmentWrap}>
        <View style={styles.segment}>
          {options.map((o) => {
            const active = segment === o.value;
            return (
              <Pressable
                key={o.value}
                onPress={() => setSegment(o.value)}
                style={[styles.segmentBtn, active && styles.segmentBtnActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {/* Keep both mounted-per-segment (conditional) — each owns its own query;
          react-query caches so switching back is instant. */}
      <View style={{ flex: 1 }}>
        {segment === "earnings" ? <EarningsScreen embedded /> : <MyPerformanceScreen embedded />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  segmentWrap: {
    backgroundColor: colors.white,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 4,
    width: "100%",
    maxWidth: layout.content,
    alignSelf: "center",
  },
  segmentBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 9, borderRadius: radius.sm },
  segmentBtnActive: { backgroundColor: colors.blue },
  segmentText: { fontSize: 14, fontWeight: "700", color: colors.textMuted },
  segmentTextActive: { color: colors.white },
});
