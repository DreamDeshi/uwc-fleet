import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { Card } from "../../components/Card";
import { LoadingState, ErrorState } from "../../components/States";
import { useMyPerformance, type PerformanceTier } from "../../hooks/queries";
import { formatMoney } from "../../lib/format";

// Tier → hero gradient + medal icon. Gold/Silver/Bronze get distinct, obvious
// colours so the driver reads their standing at a glance.
const TIER_STYLE: Record<PerformanceTier, { gradient: [string, string]; icon: keyof typeof Ionicons.glyphMap }> = {
  Gold: { gradient: ["#F4B53F", "#D98E04"], icon: "trophy" },
  Silver: { gradient: ["#9AA4B2", "#647084"], icon: "medal" },
  Bronze: { gradient: ["#C77B43", "#9A5B2B"], icon: "medal-outline" },
};
const NEUTRAL_GRADIENT: [string, string] = ["#94A3B8", "#64748B"];

export function MyPerformanceScreen() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch, isRefetching } = useMyPerformance();

  return (
    <View style={styles.fill}>
      <Header title={t("myPerformance.title")} />
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 28 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        >
          {data.has_data && data.tier ? (
            <Loaded data={data} />
          ) : (
            <Empty />
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Loaded({ data }: { data: NonNullable<ReturnType<typeof useMyPerformance>["data"]> }) {
  const { t } = useTranslation();
  const tier = data.tier as PerformanceTier;
  const tierStyle = TIER_STYLE[tier];
  const tierName = t(`myPerformance.tier${tier}`);

  const stats: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string }[] = [
    { icon: "time-outline", value: `${Math.round(data.on_time_rate)}%`, label: t("myPerformance.onTime") },
    { icon: "checkmark-done-outline", value: `${Math.round(data.completion_rate)}%`, label: t("myPerformance.completion") },
    { icon: "cube-outline", value: `${data.total_completed}`, label: t("myPerformance.tripsCompleted") },
    { icon: "cash-outline", value: formatMoney(data.rm_earned_this_month), label: t("myPerformance.rmEarned") },
  ];

  return (
    <>
      {/* Tier + score hero */}
      <LinearGradient
        colors={tierStyle.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroTierRow}>
          <Ionicons name={tierStyle.icon} size={22} color={colors.white} />
          <Text style={styles.heroTier}>{t("myPerformance.tierLabel", { tier: tierName })}</Text>
        </View>
        <Text style={styles.heroScore}>{data.total_score.toFixed(1)}</Text>
        <Text style={styles.heroOutOf}>{t("myPerformance.outOf")}</Text>
      </LinearGradient>

      {/* Anonymous percentile band — encouragement, never a named leaderboard */}
      {data.percentile_band ? (
        <View style={styles.band}>
          <Ionicons name="trending-up" size={16} color={colors.green} />
          <Text style={styles.bandText}>
            {t("myPerformance.bandLine", { band: data.percentile_band })}
          </Text>
        </View>
      ) : null}

      {/* Stat cards */}
      <View style={styles.statGrid}>
        {stats.map((s) => (
          <View key={s.label} style={styles.statCard}>
            <Ionicons name={s.icon} size={18} color={colors.blue} />
            <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
              {s.value}
            </Text>
            <Text style={styles.statLabel} numberOfLines={2}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>

      <Card style={{ marginTop: 16 }}>
        <Text style={styles.howText}>{t("myPerformance.howItWorks")}</Text>
      </Card>
    </>
  );
}

function Empty() {
  const { t } = useTranslation();
  return (
    <>
      <LinearGradient
        colors={NEUTRAL_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <Ionicons name="speedometer-outline" size={30} color={colors.white} />
        <Text style={[styles.heroTier, { marginTop: 8 }]}>{t("myPerformance.emptyTier")}</Text>
      </LinearGradient>

      <Card style={{ marginTop: 16, alignItems: "center", paddingVertical: 28 }}>
        <Ionicons name="trophy-outline" size={34} color={colors.textFaint} />
        <Text style={styles.emptyTitle}>{t("myPerformance.emptyTitle")}</Text>
        <Text style={styles.emptyBody}>{t("myPerformance.emptyBody")}</Text>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },

  hero: { borderRadius: radius.xl, padding: 24, alignItems: "center", ...shadow.card },
  heroTierRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heroTier: { color: colors.white, fontSize: 15, fontWeight: "800", letterSpacing: 0.5 },
  heroScore: { color: colors.white, fontSize: 56, fontWeight: "900", letterSpacing: -2, marginTop: 6 },
  heroOutOf: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "600", marginTop: -2 },

  band: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.tintGreen,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  bandText: { flex: 1, color: colors.green, fontSize: 13.5, fontWeight: "700" },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  statCard: {
    flexBasis: "48%",
    flexGrow: 1,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: 14,
    alignItems: "center",
    ...shadow.card,
  },
  statValue: { fontSize: 22, fontWeight: "900", color: colors.navy, marginTop: 8 },
  statLabel: { fontSize: 10.5, color: colors.textFaint, fontWeight: "700", textTransform: "uppercase", marginTop: 4, textAlign: "center", letterSpacing: 0.3 },

  howText: { fontSize: 12.5, color: colors.textMuted, lineHeight: 18 },

  emptyTitle: { fontSize: 16, fontWeight: "800", color: colors.navy, marginTop: 12 },
  emptyBody: { fontSize: 13, color: colors.textMuted, textAlign: "center", lineHeight: 19, marginTop: 6 },
});
