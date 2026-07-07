import React, { useMemo } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { DriverTabParamList } from "../../navigation/types";
import { useIncentives } from "../../hooks/queries";
import { colors, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { Card } from "../../components/Card";
import { WeeklyEarningsChart } from "../../components/WeeklyEarningsChart";
import { LoadingState, ErrorState, EmptyState } from "../../components/States";
import { WebRefreshButton } from "../../components/WebRefreshButton";
import { formatMoney, formatDate, formatDateTime, monthYear, weekdayShortNames } from "../../lib/format";

export function EarningsScreen() {
  const { t, i18n } = useTranslation();
  // Localised Mon-first axis labels (were a hardcoded English array — a Malay/
  // Chinese driver saw English on his own pay screen). i18n.language in the
  // memo deps so the chart relabels on a live language switch.
  const WEEKDAYS = useMemo(() => weekdayShortNames(), [i18n.language]);
  const navigation = useNavigation<BottomTabNavigationProp<DriverTabParamList>>();
  const { data, isLoading, isError, refetch, isRefetching } = useIncentives();

  const openTrip = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "TripDetails", params: { tripId } });

  // Earnings per weekday for the current week (Mon-Sun), summed from completed
  // trips. Drives the bar chart.
  const week = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0, 0, 0];
    if (!data) return buckets.map((amount, x) => ({ x, amount, label: WEEKDAYS[x] }));
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dow = (now.getDay() + 6) % 7; // Mon = 0
    const monday = new Date(now);
    monday.setDate(now.getDate() - dow);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    for (const tr of data.trips) {
      const d = new Date(tr.pickup_datetime);
      if (d >= monday && d < nextMonday) {
        buckets[(d.getDay() + 6) % 7] += Number(tr.incentive_earned ?? 0);
      }
    }
    return buckets.map((amount, x) => ({ x, amount, label: WEEKDAYS[x] }));
  }, [data, WEEKDAYS]);

  const weekMax = Math.max(...week.map((d) => d.amount), 0);
  const hasWeekData = weekMax > 0;

  // Average is always derivable client-side; distance comes from the API (zone
  // estimate). Both are guarded so an older API build never shows NaN.
  const avgPerTrip = data && data.summary.trip_count > 0 ? data.summary.total / data.summary.trip_count : 0;
  const totalDistance = data
    ? Number.isFinite(data.summary.total_distance_km)
      ? data.summary.total_distance_km
      : data.trips.reduce((s, tr) => s + (Number(tr.distance_km) || 0), 0)
    : 0;

  return (
    <View style={styles.fill}>
      <Header title={t("earnings.title")} />
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState onRetry={refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        >
          {/* Browsers can't pull-to-refresh — web drivers resync here. */}
          <WebRefreshButton
            refreshing={isRefetching}
            onRefresh={refetch}
            style={{ marginBottom: 12 }}
          />
          {/* Gradient summary card */}
          <LinearGradient
            colors={[colors.blueDark, colors.blue]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summaryCard}
          >
            <Text style={styles.summaryMonth}>{monthYear(data.summary.month)}</Text>
            <Text style={styles.summaryAmount}>{formatMoney(data.summary.total)}</Text>
            <Text style={styles.summaryMeta}>
              {t("earnings.tripsCount", { count: data.summary.trip_count })}
            </Text>
          </LinearGradient>

          {/* Weekly chart */}
          <Card style={{ marginTop: 16 }}>
            <Text style={styles.cardTitle}>{t("earnings.thisWeek")}</Text>
            {hasWeekData ? (
              <>
                <WeeklyEarningsChart data={week} weekMax={weekMax} />
                <View style={styles.weekLabels}>
                  {week.map((d) => (
                    <Text key={d.x} style={styles.weekDay}>{d.label}</Text>
                  ))}
                </View>
              </>
            ) : (
              <Text style={styles.chartEmpty}>{t("earnings.noChartData")}</Text>
            )}
          </Card>

          {/* Stat cards */}
          <View style={styles.statRow}>
            <StatCard
              icon="speedometer-outline"
              value={`${Math.round(totalDistance)}`}
              unit={t("earnings.km")}
              label={t("earnings.totalDistance")}
            />
            <StatCard
              icon="checkmark-done-outline"
              value={`${data.summary.trip_count}`}
              label={t("earnings.tripsCompleted")}
            />
            <StatCard
              icon="trending-up-outline"
              value={formatMoney(avgPerTrip)}
              label={t("earnings.avgPerTrip")}
            />
          </View>

          {/* Breakdown */}
          <Text style={styles.breakdownTitle}>{t("earnings.breakdown")}</Text>
          {data.trips.length === 0 ? (
            <EmptyState message={t("earnings.noEarnings")} icon="cash-outline" />
          ) : (
            <Card padded={false} style={{ overflow: "hidden" }}>
              {data.trips.map((tr, i) => (
                <TouchableOpacity
                  key={tr.id}
                  activeOpacity={0.7}
                  onPress={() => openTrip(tr.id)}
                  style={[styles.row, i < data.trips.length - 1 && styles.divider]}
                >
                  <View style={styles.rowIcon}>
                    <Ionicons name="location" size={16} color={colors.blue} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowRoute} numberOfLines={1}>
                      {tr.destination ?? tr.ticket_number}
                    </Text>
                    <View style={styles.rowMetaLine}>
                      {/* The delivery-confirm time is what the pay keyed on
                          (rate tier + pay day) — show it when recorded so a
                          boundary dispute is checkable from this screen. */}
                      <Text style={styles.rowMeta}>
                        {tr.delivered_at
                          ? t("earnings.deliveredMeta", { when: formatDateTime(tr.delivered_at) })
                          : formatDate(tr.pickup_datetime)}
                      </Text>
                      {tr.truck_plate ? (
                        <>
                          <Text style={styles.rowDot}>·</Text>
                          <Ionicons name="car-outline" size={12} color={colors.textFaint} />
                          <Text style={styles.rowMeta}>{tr.truck_plate}</Text>
                        </>
                      ) : null}
                    </View>
                  </View>
                  <Text style={styles.rowRm}>{formatMoney(tr.incentive_earned)}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              ))}
            </Card>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function StatCard({
  icon,
  value,
  unit,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  unit?: string;
  label: string;
}) {
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={18} color={colors.blue} />
      <View style={styles.statValueRow}>
        <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
        {unit ? <Text style={styles.statUnit}>{unit}</Text> : null}
      </View>
      <Text style={styles.statLabel} numberOfLines={2}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  summaryCard: { borderRadius: radius.xl, padding: 22, ...shadow.card },
  summaryMonth: { color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: "600", marginBottom: 4 },
  summaryAmount: { color: colors.white, fontSize: 42, fontWeight: "900", letterSpacing: -1 },
  summaryMeta: { color: "rgba(255,255,255,0.8)", fontSize: 14, marginTop: 4 },

  cardTitle: { fontSize: 14, fontWeight: "700", color: colors.navy, marginBottom: 12 },
  weekLabels: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, marginTop: 6 },
  weekDay: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "700", color: colors.textFaint },
  chartEmpty: { fontSize: 14, color: colors.textMuted, paddingVertical: 24, textAlign: "center" },

  statRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  statCard: { flex: 1, backgroundColor: colors.white, borderRadius: radius.md, padding: 14, alignItems: "center", ...shadow.card },
  statValueRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 8, gap: 3 },
  statValue: { fontSize: 20, fontWeight: "900", color: colors.navy },
  statUnit: { fontSize: 12, fontWeight: "700", color: colors.textFaint, marginBottom: 3 },
  statLabel: { fontSize: 12, color: colors.textFaint, fontWeight: "700", textTransform: "uppercase", marginTop: 4, textAlign: "center", letterSpacing: 0.3 },

  breakdownTitle: { fontSize: 15, fontWeight: "700", color: colors.navy, marginTop: 20, marginBottom: 12 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 14, gap: 10 },
  rowIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rowRoute: { fontSize: 14, fontWeight: "700", color: colors.navy },
  rowMetaLine: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  rowMeta: { fontSize: 12, color: colors.textFaint },
  rowDot: { fontSize: 12, color: colors.textFaint, marginHorizontal: 1 },
  rowRm: { fontSize: 15, fontWeight: "800", color: colors.green },
});
