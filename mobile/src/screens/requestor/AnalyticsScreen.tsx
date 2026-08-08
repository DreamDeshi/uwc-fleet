import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useMyAnalytics, useTrips } from "../../hooks/queries";
import { useWide } from "../../hooks/useWide";
import { colors, layout, radius, statusColors } from "../../theme";
import { Card } from "../../components/Card";
import { LoadingState, ErrorState } from "../../components/States";
import { WeeklyEarningsChart, WeekDatum } from "../../components/WeeklyEarningsChart";
import { periodStats, weekSeries, type InsightsPeriod } from "../../lib/requestorInsights";
import { monthYear, weekdayShortNames } from "../../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthShort(key: string): string {
  const m = Number(key.split("-")[1]);
  return MONTHS[m - 1] ?? key;
}

/** "YYYY-MM" for `monthYear`, which is the app's localised month formatter. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function AnalyticsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const wide = useWide();
  const { data, isLoading, isError, refetch, isRefetching } = useMyAnalytics();
  // The trips list is already loaded and polled by every requestor screen, and
  // it carries stops and cargo — so the design's period toggle, week chart and
  // stat tiles need no API change. See lib/requestorInsights for why.
  const { data: trips = [] } = useTrips();
  const [period, setPeriod] = useState<InsightsPeriod>("month");

  const totalTrips = useMemo(() => {
    if (!data) return 0;
    const s = data.status_breakdown;
    return s.completed + s.pending + s.assigned + s.in_progress + s.cancelled;
  }, [data]);

  const { stats, week, weekMax } = useMemo(() => {
    const now = new Date();
    const week = weekSeries(trips, now);
    return {
      stats: periodStats(trips, period, now),
      week,
      weekMax: Math.max(1, ...week.map((b) => b.count)),
    };
  }, [trips, period]);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 12 }, wide && styles.headerWide]}>
      <View style={wide ? styles.fillCol : styles.centerCol}>
        <Text style={styles.title}>{t("analytics.title")}</Text>
        <Text style={styles.subtitle}>{t("analytics.subtitle")}</Text>
      </View>
    </View>
  );

  const periodTabs = (
    <View style={styles.periodBar}>
      {(["month", "quarter"] as const).map((p) => {
        const active = period === p;
        return (
          <TouchableOpacity
            key={p}
            style={[styles.periodBtn, active && styles.periodBtnActive]}
            onPress={() => setPeriod(p)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.periodText, active && styles.periodTextActive]} numberOfLines={1}>
              {t(p === "month" ? "analytics.periodMonth" : "analytics.periodQuarter")}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const heroBlock = (
    <View style={styles.hero}>
      <Text style={styles.heroLabel}>
        {period === "month" ? monthYear(monthKey(new Date())) : t("analytics.periodQuarter")}
      </Text>
      <Text style={styles.heroValue}>{t("analytics.tripsValue", { count: stats.total })}</Text>
      {/* No baseline → no claim. "▲ ∞%" against a zero prior period is not a
          fact, and a flat "0%" would read as "no change" rather than "no data". */}
      <Text style={styles.heroDelta}>
        {stats.deltaPct === null
          ? t("analytics.noBaseline")
          : t(stats.deltaPct >= 0 ? "analytics.deltaUp" : "analytics.deltaDown", {
              pct: Math.abs(stats.deltaPct),
            })}
      </Text>
      <View style={styles.heroChip}>
        <Ionicons name="shield-checkmark" size={15} color={colors.yellow} />
        <Text style={styles.heroChipText}>{t("analytics.trackedToDelivery")}</Text>
      </View>
    </View>
  );

  const weekBlock = (
    <Card>
      <Text style={styles.weekTitle}>{t("analytics.thisWeek")}</Text>
      <View style={styles.weekChart}>
        {week.map((bar) => (
          <View
            key={bar.index}
            style={[
              styles.weekBar,
              {
                // A zero day still gets a visible stub, so the axis reads as
                // seven days rather than a chart with holes in it.
                height: Math.max(6, (bar.count / weekMax) * 84),
                backgroundColor: bar.isToday ? colors.blue : "#eceff6",
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.weekAxis}>
        {weekdayShortNames().map((d, i) => (
          <Text
            key={`${d}-${i}`}
            style={[styles.weekAxisLabel, week[i]?.isToday && styles.weekAxisLabelToday]}
            numberOfLines={1}
          >
            {d}
          </Text>
        ))}
      </View>
    </Card>
  );

  const tilesBlock = (
    <View style={styles.tileRow}>
      <Tile
        icon="cube-outline"
        value={stats.avgPallets === null ? "—" : String(stats.avgPallets)}
        label={t("analytics.avgPallets")}
      />
      <Tile icon="checkmark-done-outline" value={String(stats.completed)} label={t("analytics.tripsDone")} />
      <Tile
        icon="trending-up-outline"
        value={stats.cancelledPct === null ? "—" : `${stats.cancelledPct}%`}
        label={t("analytics.cancelledRate")}
      />
    </View>
  );

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !data) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  // New requestor (no trips yet) → friendly empty state, no broken charts.
  if (totalTrips === 0) {
    return (
      <ScrollView
        style={styles.fill}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {header}
        <View style={styles.section}>
          <Card>
            <View style={styles.emptyBox}>
              <Ionicons name="bar-chart-outline" size={34} color={colors.textFaint} />
              <Text style={styles.emptyTitle}>{t("analytics.noData")}</Text>
              <Text style={styles.emptyHint}>{t("analytics.noDataHint")}</Text>
            </View>
          </Card>
        </View>
      </ScrollView>
    );
  }

  // ── Monthly activity → bar chart (reuses the driver earnings chart) ──
  const monthMax = Math.max(1, ...data.monthly_activity.map((m) => m.count));
  const chartData: WeekDatum[] = data.monthly_activity.map((mb, i) => ({
    x: i,
    amount: mb.count,
    label: monthShort(mb.month),
  }));

  // ── Status breakdown → coloured proportional bars (victory-native v41 has no
  // pie, so we render a labelled breakdown per the spec fallback) ──
  const sb = data.status_breakdown;
  // Bar colors come from the shared status map so the breakdown, the badges
  // and the admin board all speak the same hue per status.
  const statuses = [
    { label: t("analytics.statusCompleted"), color: statusColors.completed.bg, value: sb.completed },
    { label: t("analytics.statusInProgress"), color: statusColors.in_progress.bg, value: sb.in_progress },
    { label: t("analytics.statusAssigned"), color: statusColors.assigned.bg, value: sb.assigned },
    { label: t("analytics.statusPending"), color: statusColors.pending.bg, value: sb.pending },
    { label: t("analytics.statusCancelled"), color: statusColors.cancelled.bg, value: sb.cancelled },
  ];

  // ── Section blocks (same markup either way; composed stacked or in a grid) ──
  const monthlyBlock = (
    <View>
      <Text style={styles.sectionTitle}>{t("analytics.monthlyActivity")}</Text>
      <Card style={{ marginTop: 12 }}>
        <Text style={styles.cardSub}>{t("analytics.monthlyActivitySub")}</Text>
        <WeeklyEarningsChart data={chartData} weekMax={monthMax} />
        <View style={styles.monthLabels}>
          {data.monthly_activity.map((mb) => (
            <View key={mb.month} style={styles.monthCol}>
              <Text style={styles.monthCount}>{mb.count}</Text>
              <Text style={styles.monthLabel}>{monthShort(mb.month)}</Text>
            </View>
          ))}
        </View>
      </Card>
    </View>
  );

  const statusBlock = (
    <View>
      <Text style={styles.sectionTitle}>{t("analytics.statusBreakdown")}</Text>
      <Card style={{ marginTop: 12 }}>
        {statuses.map((s) => (
          <View key={s.label} style={styles.statusRow}>
            <Text style={styles.statusLabel}>{s.label}</Text>
            <View style={styles.statusTrack}>
              <View
                style={[
                  styles.statusFill,
                  { backgroundColor: s.color, width: `${(s.value / totalTrips) * 100}%` },
                ]}
              />
            </View>
            <Text style={styles.statusValue}>{s.value}</Text>
          </View>
        ))}
      </Card>
    </View>
  );

  const destinationsBlock = (
    <View>
      <Text style={styles.sectionTitle}>{t("analytics.topDestinations")}</Text>
      {data.top_destinations.length === 0 ? (
        <Card style={{ marginTop: 12 }}>
          <Text style={styles.emptyHint}>{t("analytics.noDestinations")}</Text>
        </Card>
      ) : (
        <Card style={{ marginTop: 12 }} padded={false}>
          {data.top_destinations.map((d, i) => (
            <View
              key={d.name}
              style={[styles.destRow, i < data.top_destinations.length - 1 && styles.divider]}
            >
              <View style={styles.rankBadge}>
                <Text style={styles.rankText}>{i + 1}</Text>
              </View>
              <Text style={styles.destName} numberOfLines={1}>{d.name}</Text>
              <Text style={styles.destCount}>
                {d.count} {t("analytics.trips")}
              </Text>
            </View>
          ))}
        </Card>
      )}
    </View>
  );

  const cargoBlock = (
    <View>
      <Text style={styles.sectionTitle}>{t("analytics.cargoHistory")}</Text>
      <Card style={{ marginTop: 12 }}>
        <View style={styles.totalPalletsBox}>
          <Text style={styles.totalPalletsValue}>{data.cargo_history.total_pallets}</Text>
          <Text style={styles.totalPalletsLabel}>{t("analytics.totalPallets")}</Text>
        </View>
        {data.cargo_history.by_size.length === 0 ? (
          <Text style={[styles.emptyHint, { marginTop: 12 }]}>{t("analytics.noCargo")}</Text>
        ) : (
          <View style={styles.sizeWrap}>
            {data.cargo_history.by_size.map((s) => (
              <View key={s.size} style={styles.sizeChip}>
                <Text style={styles.sizeName}>{s.size}</Text>
                <Text style={styles.sizeCount}>{s.count}</Text>
              </View>
            ))}
          </View>
        )}
      </Card>
    </View>
  );

  const approvalBlock = (
    <View>
      <Text style={styles.sectionTitle}>{t("analytics.avgApproval")}</Text>
      <Card style={{ marginTop: 12 }}>
        <View style={styles.approvalRow}>
          <View style={styles.approvalIcon}>
            <Ionicons name="time-outline" size={22} color={colors.blue} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.approvalValue}>
              {data.avg_approval_time_hours === null
                ? "—"
                : `${data.avg_approval_time_hours} ${t("analytics.hours")}`}
            </Text>
            <Text style={styles.approvalSub}>{t("analytics.avgApprovalSub")}</Text>
          </View>
        </View>
      </Card>
    </View>
  );

  // ── Wide (PC) — a two/three-column grid instead of a lone centered column ──
  if (wide) {
    return (
      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {header}
        <View style={styles.wideBody}>
          {periodTabs}
          <View style={styles.wideRow}>
            <View style={{ flex: 1 }}>{heroBlock}</View>
            <View style={{ flex: 1.4, gap: 18 }}>
              {weekBlock}
              {tilesBlock}
            </View>
          </View>
          <View style={styles.wideRow}>
            <View style={{ flex: 1.5 }}>{monthlyBlock}</View>
            <View style={{ flex: 1 }}>{statusBlock}</View>
          </View>
          <View style={styles.wideRow}>
            <View style={{ flex: 1 }}>{destinationsBlock}</View>
            <View style={{ flex: 1 }}>{cargoBlock}</View>
            <View style={{ flex: 1 }}>{approvalBlock}</View>
          </View>
        </View>
      </ScrollView>
    );
  }

  // ── Narrow (phone) — design frame 11 on top, the pre-aggregated sections the
  // frame does not draw kept below it. Nothing a requestor had is removed.
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={{ paddingBottom: 28 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
    >
      {header}
      <View style={styles.section}>{periodTabs}</View>
      <View style={[styles.section, { gap: 14 }]}>
        {heroBlock}
        {weekBlock}
        {tilesBlock}
      </View>
      <View style={styles.section}>{monthlyBlock}</View>
      <View style={styles.section}>{statusBlock}</View>
      <View style={styles.section}>{destinationsBlock}</View>
      <View style={styles.section}>{cargoBlock}</View>
      <View style={styles.section}>{approvalBlock}</View>
    </ScrollView>
  );
}

function Tile({
  icon,
  value,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  label: string;
}) {
  return (
    <View style={styles.tile}>
      <Ionicons name={icon} size={20} color={colors.blue} />
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 20 },
  title: { color: colors.white, fontSize: 20, fontWeight: "800", marginTop: 4 },
  subtitle: { color: "rgba(255,255,255,0.75)", fontSize: 14, marginTop: 2 },
  section: { paddingHorizontal: 16, paddingTop: 16, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },
  cardSub: { fontSize: 13, color: colors.textMuted, marginBottom: 6 },

  // Wide grid scaffold — fills the content area beside the sidebar.
  headerWide: { paddingHorizontal: 28 },
  fillCol: { width: "100%" },
  wideBody: { width: "100%", paddingHorizontal: 28, paddingTop: 18, gap: 18 },
  wideRow: { flexDirection: "row", alignItems: "flex-start", gap: 18 },

  // ── Design frame 11 ──
  periodBar: { flexDirection: "row", gap: 4, backgroundColor: "#eceff6", borderRadius: radius.md, padding: 5, alignSelf: "stretch", maxWidth: 420 },
  periodBtn: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, minHeight: 38, paddingHorizontal: 8, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  periodBtnActive: { backgroundColor: colors.blue },
  periodText: { fontSize: 14, fontWeight: "700", color: colors.textMuted },
  periodTextActive: { color: colors.white },

  hero: { backgroundColor: colors.blue, borderRadius: radius.xl, padding: 22, gap: 10 },
  heroLabel: { fontSize: 12, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", color: "#c9d6f0" },
  heroValue: { fontSize: 36, fontWeight: "900", color: colors.white, letterSpacing: -1, lineHeight: 42 },
  heroDelta: { fontSize: 13, color: "#c9d6f0" },
  heroChip: { alignSelf: "flex-start", marginTop: 4, flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 },
  heroChipText: { flexShrink: 1, fontSize: 12, fontWeight: "700", color: colors.white },

  weekTitle: { fontSize: 16, fontWeight: "800", color: colors.navy, marginBottom: 14 },
  weekChart: { flexDirection: "row", alignItems: "flex-end", gap: 10, height: 90, paddingHorizontal: 2 },
  weekBar: { flex: 1, borderTopLeftRadius: 5, borderTopRightRadius: 5 },
  weekAxis: { flexDirection: "row", marginTop: 10 },
  weekAxisLabel: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "700", color: colors.textFaint },
  weekAxisLabelToday: { color: colors.blue },

  tileRow: { flexDirection: "row", gap: 10 },
  tile: { flex: 1, minWidth: 0, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.borderLight, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center", gap: 6 },
  tileValue: { fontSize: 18, fontWeight: "900", color: colors.navy },
  tileLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3, textTransform: "uppercase", color: colors.textMuted, textAlign: "center" },

  monthLabels: { flexDirection: "row", marginTop: 8, paddingHorizontal: 4 },
  monthCol: { flex: 1, alignItems: "center" },
  monthCount: { fontSize: 13, fontWeight: "800", color: colors.navy },
  monthLabel: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  statusLabel: { fontSize: 13, color: colors.navy, fontWeight: "600", width: 86 },
  statusTrack: { flex: 1, height: 10, backgroundColor: colors.bg, borderRadius: 999, overflow: "hidden" },
  statusFill: { height: "100%", borderRadius: 999, minWidth: 2 },
  statusValue: { fontSize: 14, fontWeight: "800", color: colors.navy, width: 26, textAlign: "right" },

  destRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rankBadge: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  rankText: { fontSize: 13, fontWeight: "800", color: colors.blue },
  destName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.navy },
  destCount: { fontSize: 13, fontWeight: "700", color: colors.textMuted },

  totalPalletsBox: { alignItems: "center", paddingVertical: 6 },
  totalPalletsValue: { fontSize: 34, fontWeight: "900", color: colors.blue },
  totalPalletsLabel: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  sizeWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  sizeChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.tintBlue, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  sizeName: { fontSize: 13, fontWeight: "700", color: colors.blue },
  sizeCount: { fontSize: 13, fontWeight: "800", color: colors.navy, backgroundColor: colors.white, borderRadius: 999, paddingHorizontal: 7, overflow: "hidden" },

  approvalRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  approvalIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  approvalValue: { fontSize: 22, fontWeight: "900", color: colors.navy },
  approvalSub: { fontSize: 13, color: colors.textMuted, marginTop: 1 },

  emptyBox: { alignItems: "center", paddingVertical: 26, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "800", color: colors.navy },
  emptyHint: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20, paddingHorizontal: 12 },
});
