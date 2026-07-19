// Driver performance — split by layout (owner direction, 2026-07-19/20):
//   WIDE (PC): the new leaderboard look — a PODIUM for the top 3 + one ranked
//   table carrying the stats that matter (score, tier, on-time %, completion %,
//   trips, RM, distance) + a workload-balance note. Replaces the old four
//   stacked tables that repeated the same numbers.
//   NARROW (phone): the ORIGINAL lens layout (leaderboard cards + reliability +
//   productivity + workload) — the wide podium/table doesn't fit a phone, and
//   the old cards already read well there.
// Same hook + same weighted score; only presentation changed.
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useDriverPerformance } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Avatar,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Pill,
  ProgressBar,
  SectionTitle,
  TableCell,
  TableHeader,
  TableRow,
  TableScroll,
} from "../components/ui";
import { formatMoney } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DriverPerformance } from "../types";

function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}
const tierKeyFor = (s: number) =>
  s >= 75 ? "admin.performance.tierGold" : s >= 50 ? "admin.performance.tierSilver" : "admin.performance.tierBronze";

const MEDAL: Record<1 | 2 | 3, { bg: string; border: string; accent: string; icon: keyof typeof Ionicons.glyphMap }> = {
  1: { bg: "#FFF7E0", border: "#F0D98A", accent: "#D98E04", icon: "trophy" },
  2: { bg: "#EEF1F6", border: "#D3DAE4", accent: "#64748B", icon: "medal" },
  3: { bg: "#F6E9DC", border: "#E4CBB2", accent: "#9A5B2B", icon: "medal-outline" },
};

const onTimeText = (d: DriverPerformance) => (d.total_completed > 0 ? `${d.on_time_rate.toFixed(0)}%` : "—");
const completionText = (d: DriverPerformance) =>
  d.total_completed + d.total_cancelled > 0 ? `${d.completion_rate.toFixed(0)}%` : "—";

export function PerformanceScreen() {
  const { t } = useTranslation();
  const performance = useDriverPerformance();
  const wide = useLayoutMode() === "wide";

  const ranked = useMemo(
    () => [...(performance.data ?? [])].sort((a, b) => b.total_score - a.total_score),
    [performance.data]
  );

  if (performance.isLoading) return <Loading />;
  if (performance.isError)
    return <ErrorState message={t("admin.performance.loadError")} onRetry={() => performance.refetch()} />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 20 } : { padding: 14, gap: 20 }}
      refreshControl={<RefreshControl refreshing={performance.isRefetching} onRefresh={() => performance.refetch()} />}
    >
      {ranked.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.performance.noDrivers")} />
        </Card>
      ) : wide ? (
        <WideBody ranked={ranked} />
      ) : (
        <NarrowBody ranked={ranked} />
      )}
    </ScrollView>
  );
}

// ── WIDE: podium + one enriched leaderboard + workload note ──────────────
function WideBody({ ranked }: { ranked: DriverPerformance[] }) {
  const { t } = useTranslation();
  const podium = ranked.filter((d) => d.total_completed > 0).slice(0, 3);
  const right = { textAlign: "right" as const, fontWeight: "700" as const };
  return (
    <>
      {podium.length > 0 && <Podium drivers={podium} />}

      <Card>
        <SectionTitle title={t("admin.performance.leaderboard")} />
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: -4, marginBottom: 14 }}>
          {t("admin.performance.intro")}
        </Text>
        <TableScroll minWidth={900}>
          <TableHeader>
            <TableCell flex={0.4} header>#</TableCell>
            <TableCell flex={1.8} header>{t("admin.performance.driver")}</TableCell>
            <TableCell flex={1} header>{t("admin.performance.score")}</TableCell>
            <TableCell flex={0.9} header>{t("admin.performance.tier")}</TableCell>
            <TableCell flex={0.9} header textStyle={{ textAlign: "right" }}>{t("admin.performance.onTime")}</TableCell>
            <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.completion")}</TableCell>
            <TableCell flex={0.7} header textStyle={{ textAlign: "right" }}>{t("admin.performance.tripsShort")}</TableCell>
            <TableCell flex={1.1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.rmMonth")}</TableCell>
            <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.distMonth")}</TableCell>
          </TableHeader>
          {ranked.map((d, i) => {
            const scored = d.total_completed > 0;
            return (
              <TableRow key={d.id}>
                <TableCell flex={0.4} textStyle={{ fontWeight: "800", color: i < 3 ? MEDAL[(i + 1) as 1 | 2 | 3].accent : colors.textFaint }}>
                  {i + 1}
                </TableCell>
                <TableCell flex={1.8}><DriverCell d={d} avatar /></TableCell>
                <TableCell flex={1}><ScoreBadge score={d.total_score} completed={d.total_completed} /></TableCell>
                <TableCell flex={0.9}>
                  {scored ? <Pill {...scoreColor(d.total_score)}>{t(tierKeyFor(d.total_score))}</Pill> : <Text style={{ color: colors.textFaint }}>—</Text>}
                </TableCell>
                <TableCell flex={0.9} textStyle={right}>{onTimeText(d)}</TableCell>
                <TableCell flex={1} textStyle={right}>{completionText(d)}</TableCell>
                <TableCell flex={0.7} textStyle={right}>{d.total_completed}</TableCell>
                <TableCell flex={1.1} textStyle={right}>{formatMoney(d.rm_earned_this_month)}</TableCell>
                <TableCell flex={1} textStyle={right}>{`${Math.round(d.distance_km_this_month)} km`}</TableCell>
              </TableRow>
            );
          })}
        </TableScroll>
      </Card>

      <Workload drivers={ranked} />
    </>
  );
}

// ── NARROW: the original lens layout ─────────────────────────────────────
function NarrowBody({ ranked }: { ranked: DriverPerformance[] }) {
  return (
    <>
      <Leaderboard ranked={ranked} />
      <Reliability drivers={ranked} />
      <Productivity drivers={ranked} />
      <Workload drivers={ranked} />
    </>
  );
}

// ── Podium (wide) — top 3, winner centred + raised ───────────────────────
function Podium({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const slots = [drivers[1], drivers[0], drivers[2]].filter(Boolean) as DriverPerformance[];
  const rankOf = (d: DriverPerformance) => drivers.indexOf(d) + 1;
  return (
    <Card>
      <SectionTitle title={t("admin.performance.topPerformers")} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 10, marginTop: 8 }}>
        {slots.map((d) => {
          const rank = rankOf(d) as 1 | 2 | 3;
          const m = MEDAL[rank];
          const first = rank === 1;
          const sc = scoreColor(d.total_score);
          return (
            <View
              key={d.id}
              style={{
                flex: 1,
                maxWidth: 200,
                alignItems: "center",
                backgroundColor: m.bg,
                borderWidth: 1,
                borderColor: m.border,
                borderRadius: radius.lg,
                paddingVertical: first ? 18 : 14,
                paddingHorizontal: 10,
                marginTop: first ? 0 : 22,
              }}
            >
              <View style={{ width: first ? 44 : 38, height: first ? 44 : 38, borderRadius: 22, backgroundColor: m.accent, alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                <Ionicons name={m.icon} size={first ? 24 : 20} color="#fff" />
              </View>
              <Text style={{ fontSize: font.xs, fontWeight: "800", color: m.accent, marginBottom: 4 }}>#{rank}</Text>
              <Avatar name={d.name} size={first ? 40 : 34} />
              <Text numberOfLines={1} style={{ fontSize: font.sm, fontWeight: "800", color: colors.text, marginTop: 6, maxWidth: "100%" }}>
                {d.name}
              </Text>
              {d.truck_plate ? <Text numberOfLines={1} style={{ fontSize: font.xs, color: colors.textFaint }}>{d.truck_plate}</Text> : null}
              <Text style={{ fontSize: first ? 24 : 20, fontWeight: "900", color: m.accent, marginTop: 6 }}>{d.total_score.toFixed(1)}</Text>
              <View style={{ backgroundColor: sc.bg, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 9, marginTop: 4 }}>
                <Text style={{ color: sc.fg, fontSize: font.xs, fontWeight: "800" }}>{t(tierKeyFor(d.total_score))}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────
function Lens({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  const narrow = useLayoutMode() === "narrow";
  return (
    <Card>
      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: font.xs, fontWeight: "800", letterSpacing: 1.2, color: colors.blue, textTransform: "uppercase" }}>{title}</Text>
        {!narrow && <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 3 }}>{hint}</Text>}
      </View>
      {children}
    </Card>
  );
}

function DriverCell({ d, avatar }: { d: DriverPerformance; avatar?: boolean }) {
  const text = (
    <View style={{ flex: avatar ? 1 : undefined, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ fontWeight: "700", fontSize: font.md, color: colors.text }}>{d.name}</Text>
      <Text numberOfLines={1} style={{ fontSize: font.xs, color: colors.textFaint }}>
        {d.employee_number ? `#${d.employee_number}` : "—"}
        {d.truck_plate ? ` · ${d.truck_plate}` : ""}
      </Text>
    </View>
  );
  if (!avatar) return text;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9, minWidth: 0 }}>
      <Avatar name={d.name} size={30} />
      {text}
    </View>
  );
}

function ScoreBadge({ score, completed }: { score: number; completed: number }) {
  const { t } = useTranslation();
  if (completed === 0) {
    return (
      <View style={{ backgroundColor: "#f3f4f6", paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, alignSelf: "flex-start" }}>
        <Text style={{ color: "#6b7280", fontSize: font.xs, fontWeight: "700" }}>{t("admin.performance.noData")}</Text>
      </View>
    );
  }
  const c = scoreColor(score);
  return (
    <View style={{ backgroundColor: c.bg, paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.pill, alignSelf: "flex-start" }}>
      <Text style={{ color: c.fg, fontSize: font.sm, fontWeight: "800" }}>
        {score.toFixed(1)}
        <Text style={{ fontSize: 12, fontWeight: "700", opacity: 0.7 }}>/100</Text>
      </Text>
    </View>
  );
}

function Component({ value, max, detail, label }: { value: number; max: number; detail: string; label?: string }) {
  return (
    <View style={{ minWidth: 120 }}>
      {label ? (
        <Text style={{ fontSize: font.xs, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted, marginBottom: 3 }}>{label}</Text>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4, gap: 6 }}>
        <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>
          {value.toFixed(1)}
          <Text style={{ color: colors.textFaint, fontWeight: "600" }}> / {max}</Text>
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textMuted, fontWeight: "600", fontSize: font.xs, flexShrink: 1 }}>{detail}</Text>
      </View>
      <ProgressBar pct={(value / max) * 100} />
    </View>
  );
}

// ── NARROW: leaderboard cards ────────────────────────────────────────────
function Leaderboard({ ranked }: { ranked: DriverPerformance[] }) {
  const { t } = useTranslation();
  return (
    <Lens title={t("admin.performance.leaderboard")} hint={t("admin.performance.leaderboardHint")}>
      <View style={{ gap: 10 }}>
        {ranked.map((d, i) => (
          <LeaderboardCard key={d.id} d={d} rank={i + 1} />
        ))}
      </View>
    </Lens>
  );
}

function LeaderboardCard({ d, rank }: { d: DriverPerformance; rank: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const scored = d.total_completed > 0;
  const medalTop = rank <= 3 && scored;
  return (
    <Pressable
      onPress={() => setExpanded((e) => !e)}
      style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, backgroundColor: colors.card }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: medalTop ? MEDAL[rank as 1 | 2 | 3].bg : colors.panel, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: font.sm, fontWeight: "800", color: medalTop ? MEDAL[rank as 1 | 2 | 3].accent : colors.textFaint }}>{rank}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <DriverCell d={d} />
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <ScoreBadge score={d.total_score} completed={d.total_completed} />
          {scored ? <Pill {...scoreColor(d.total_score)}>{t(tierKeyFor(d.total_score))}</Pill> : null}
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
      </View>
      {expanded && (
        <View style={{ gap: 12, marginTop: 14, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 }}>
          <Component label={t("admin.performance.onTimeCol")} value={d.on_time_component} max={40} detail={t("admin.performance.onTimeDetail", { pct: d.on_time_rate.toFixed(0) })} />
          <Component label={t("admin.performance.completionCol")} value={d.completion_component} max={30} detail={t("admin.performance.completedDetail", { pct: d.completion_rate.toFixed(0) })} />
          <Component label={t("admin.performance.incentiveCol")} value={d.points_component} max={30} detail={formatMoney(d.rm_earned_this_month)} />
        </View>
      )}
    </Pressable>
  );
}

// ── NARROW: reliability lens ─────────────────────────────────────────────
function Reliability({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const right = { textAlign: "right" as const, fontWeight: "700" as const };
  const driverFlex = narrow ? 1.2 : 1.6;
  return (
    <Lens title={t("admin.performance.reliability")} hint={t("admin.performance.reliabilityHint")}>
      <TableHeader>
        <TableCell flex={driverFlex} header>{t("admin.performance.driver")}</TableCell>
        <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.onTime")}</TableCell>
        <TableCell flex={1.2} header textStyle={{ textAlign: "right" }}>{t("admin.performance.completion")}</TableCell>
      </TableHeader>
      {drivers.map((d) => (
        <TableRow key={d.id}>
          <TableCell flex={driverFlex}><DriverCell d={d} /></TableCell>
          <TableCell flex={1} textStyle={right}>{onTimeText(d)}</TableCell>
          <TableCell flex={1.2} textStyle={right}>{completionText(d)}</TableCell>
        </TableRow>
      ))}
    </Lens>
  );
}

// ── NARROW: productivity lens ────────────────────────────────────────────
function Productivity({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const right = { textAlign: "right" as const, fontWeight: "700" as const };
  const flexes = narrow ? { driver: 1.1, trips: 0.6, rm: 1.3, km: 0.9 } : { driver: 1.5, trips: 0.8, rm: 1.1, km: 0.9 };
  return (
    <Lens title={t("admin.performance.productivity")} hint={t("admin.performance.productivityHint")}>
      <TableHeader>
        <TableCell flex={flexes.driver} header>{t("admin.performance.driver")}</TableCell>
        <TableCell flex={flexes.trips} header textStyle={{ textAlign: "right" }}>{t("admin.performance.tripsAll")}</TableCell>
        <TableCell flex={flexes.rm} header textStyle={{ textAlign: "right" }}>{t("admin.performance.rmMonth")}</TableCell>
        <TableCell flex={flexes.km} header textStyle={{ textAlign: "right" }}>{t("admin.performance.distMonth")}</TableCell>
      </TableHeader>
      {drivers.map((d) => (
        <TableRow key={d.id}>
          <TableCell flex={flexes.driver}><DriverCell d={d} /></TableCell>
          <TableCell flex={flexes.trips} textStyle={right}>{d.total_completed}</TableCell>
          <TableCell flex={flexes.rm} textStyle={right}>{formatMoney(d.rm_earned_this_month)}</TableCell>
          <TableCell flex={flexes.km} textStyle={right}>{`${Math.round(d.distance_km_this_month)} km`}</TableCell>
        </TableRow>
      ))}
    </Lens>
  );
}

// ── Workload lens — trips this month as a bar list + balance note ────────
function Workload({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const byLoad = [...drivers].sort((a, b) => b.completed_this_month - a.completed_this_month);
  const max = Math.max(...byLoad.map((d) => d.completed_this_month), 0);
  const most = byLoad[0];
  const least = byLoad[byLoad.length - 1];
  const uneven = max > 0 && most.completed_this_month !== least.completed_this_month;

  const note =
    max === 0
      ? t("admin.performance.workloadNone")
      : !uneven
        ? t("admin.performance.workloadEven", { count: most.completed_this_month })
        : t("admin.performance.workloadImbalance", { most: most.name, mostCount: most.completed_this_month, least: least.name, leastCount: least.completed_this_month });

  return (
    <Lens title={t("admin.performance.workload")} hint={t("admin.performance.workloadHint")}>
      <View style={{ backgroundColor: uneven ? colors.orangeTint : colors.blueTint, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 16 }}>
        <Text style={{ color: uneven ? colors.orange : colors.blue, fontSize: font.sm, fontWeight: "600" }}>{note}</Text>
      </View>
      <View style={{ gap: 10 }}>
        {byLoad.map((d) => {
          const pct = max > 0 ? (d.completed_this_month / max) * 100 : 0;
          const isMost = max > 0 && d.completed_this_month === most.completed_this_month;
          return (
            <View key={d.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text numberOfLines={1} style={{ width: 120, fontSize: font.sm, fontWeight: "600", color: colors.text }}>{d.name}</Text>
              <View style={{ flex: 1, backgroundColor: colors.divider, borderRadius: radius.pill, height: 22, overflow: "hidden" }}>
                <View style={{ width: `${pct}%`, minWidth: d.completed_this_month > 0 ? 24 : 0, height: "100%", backgroundColor: isMost ? colors.blue : "#7da7e0", borderRadius: radius.pill }} />
              </View>
              <Text style={{ width: 28, textAlign: "right", fontSize: font.md, fontWeight: "800", color: colors.navy }}>{d.completed_this_month}</Text>
            </View>
          );
        })}
      </View>
    </Lens>
  );
}
