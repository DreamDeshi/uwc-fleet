// Driver performance comparison — RN port of admin/src/pages/PerformancePage.tsx.
// Same hook (useDriverPerformance), same three lenses (reliability,
// productivity, workload) + the ranked leaderboard that exposes the weighted
// score components (on-time 40 · completion 30 · incentive 30) so a ranking
// is never a black box. The leaderboard is the first real user of the RN
// table pattern (TableScroll + flex rows).
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useDriverPerformance } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Pill,
  ProgressBar,
  TableCell,
  TableHeader,
  TableRow,
  TableScroll,
} from "../components/ui";
import { formatMoney } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DriverPerformance } from "../types";

// FR-FM7 — score → badge colour. green ≥75, amber 50–74, red <50 (mirrors the
// Driver Management card badge so the two pages read the same).
function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}

const tierKeyFor = (s: number) => (s >= 75 ? "admin.performance.tierGold" : s >= 50 ? "admin.performance.tierSilver" : "admin.performance.tierBronze");

export function PerformanceScreen() {
  const { t } = useTranslation();
  const performance = useDriverPerformance();
  const mode = useLayoutMode();

  const ranked = useMemo(
    () => [...(performance.data ?? [])].sort((a, b) => b.total_score - a.total_score),
    [performance.data]
  );

  if (performance.isLoading) return <Loading />;
  if (performance.isError)
    return <ErrorState message={t("admin.performance.loadError")} onRetry={() => performance.refetch()} />;

  const wide = mode === "wide";

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
      ) : (
        <>
          <Text style={{ fontSize: font.md, color: colors.textMuted, lineHeight: 21 }}>
            {t("admin.performance.intro")}
          </Text>

          <Leaderboard ranked={ranked} />

          {/* Reliability + productivity side-by-side on wide, stacked on phones. */}
          <View style={{ flexDirection: wide ? "row" : "column", gap: 20 }}>
            <View style={{ flex: wide ? 1 : undefined }}>
              <Reliability drivers={ranked} />
            </View>
            <View style={{ flex: wide ? 1 : undefined }}>
              <Productivity drivers={ranked} />
            </View>
          </View>

          <Workload drivers={ranked} />
        </>
      )}
    </ScrollView>
  );
}

// ── Lens section shell ──────────────────────────────────────────────────
function Lens({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <Card>
      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: font.xs, fontWeight: "800", letterSpacing: 1.2, color: colors.blue, textTransform: "uppercase" }}>
          {title}
        </Text>
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 3 }}>{hint}</Text>
      </View>
      {children}
    </Card>
  );
}

function DriverCell({ d }: { d: DriverPerformance }) {
  return (
    <View>
      <Text numberOfLines={1} style={{ fontWeight: "700", fontSize: font.md, color: colors.text }}>{d.name}</Text>
      <Text numberOfLines={1} style={{ fontSize: font.xs, color: colors.textFaint }}>
        {d.employee_number ? `#${d.employee_number}` : "—"}
        {d.truck_plate ? ` · ${d.truck_plate}` : ""}
      </Text>
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
        <Text style={{ fontSize: 10.5, fontWeight: "700", opacity: 0.7 }}>/100</Text>
      </Text>
    </View>
  );
}

function Component({ value, max, detail, label }: { value: number; max: number; detail: string; label?: string }) {
  return (
    <View style={{ minWidth: 120 }}>
      {label ? (
        <Text style={{ fontSize: font.xs, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted, marginBottom: 3 }}>
          {label}
        </Text>
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

// ── Ranked leaderboard — the "why" view, sorted by total score ───────────
// Owner ruling (13 Jul 2026): table on PC, stacked CARDS on phones — a wide
// table must never horizontal-scroll on a narrow screen.
function Leaderboard({ ranked }: { ranked: DriverPerformance[] }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  if (mode === "narrow") {
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
  return (
    <Lens title={t("admin.performance.leaderboard")} hint={t("admin.performance.leaderboardHint")}>
      <TableScroll minWidth={760}>
        <TableHeader>
          <TableCell flex={0.4} header>#</TableCell>
          <TableCell flex={1.6} header>{t("admin.performance.driver")}</TableCell>
          <TableCell flex={1} header>{t("admin.performance.score")}</TableCell>
          <TableCell flex={0.9} header>{t("admin.performance.tier")}</TableCell>
          <TableCell flex={1.4} header>{t("admin.performance.onTimeCol")}</TableCell>
          <TableCell flex={1.4} header>{t("admin.performance.completionCol")}</TableCell>
          <TableCell flex={1.4} header>{t("admin.performance.incentiveCol")}</TableCell>
        </TableHeader>
        {ranked.map((d, i) => {
          const scored = d.total_completed > 0;
          return (
            <TableRow key={d.id}>
              <TableCell flex={0.4} textStyle={{ fontWeight: "800", color: colors.textFaint }}>{i + 1}</TableCell>
              <TableCell flex={1.6}><DriverCell d={d} /></TableCell>
              <TableCell flex={1}><ScoreBadge score={d.total_score} completed={d.total_completed} /></TableCell>
              <TableCell flex={0.9}>
                {scored ? (
                  <Pill {...scoreColor(d.total_score)}>{t(tierKeyFor(d.total_score))}</Pill>
                ) : (
                  <Text style={{ color: colors.textFaint }}>—</Text>
                )}
              </TableCell>
              <TableCell flex={1.4}>
                <Component value={d.on_time_component} max={40} detail={t("admin.performance.onTimeDetail", { pct: d.on_time_rate.toFixed(0) })} />
              </TableCell>
              <TableCell flex={1.4}>
                <Component value={d.completion_component} max={30} detail={t("admin.performance.completedDetail", { pct: d.completion_rate.toFixed(0) })} />
              </TableCell>
              <TableCell flex={1.4}>
                <Component value={d.points_component} max={30} detail={formatMoney(d.rm_earned_this_month)} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableScroll>
    </Lens>
  );
}

// One driver as a stacked card (narrow mode): rank, name/truck, score and
// tier visible at once; the three weighted components expand on tap.
function LeaderboardCard({ d, rank }: { d: DriverPerformance; rank: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const scored = d.total_completed > 0;
  return (
    <Pressable
      onPress={() => setExpanded((e) => !e)}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        padding: 12,
        backgroundColor: colors.card,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: rank === 1 && scored ? colors.yellow : colors.panel,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: font.sm, fontWeight: "800", color: rank === 1 && scored ? colors.navy : colors.textFaint }}>
            {rank}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <DriverCell d={d} />
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <ScoreBadge score={d.total_score} completed={d.total_completed} />
          {scored ? (
            <Pill {...scoreColor(d.total_score)}>{t(tierKeyFor(d.total_score))}</Pill>
          ) : null}
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
      </View>
      {expanded && (
        <View style={{ gap: 12, marginTop: 14, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 }}>
          <Component
            label={t("admin.performance.onTimeCol")}
            value={d.on_time_component}
            max={40}
            detail={t("admin.performance.onTimeDetail", { pct: d.on_time_rate.toFixed(0) })}
          />
          <Component
            label={t("admin.performance.completionCol")}
            value={d.completion_component}
            max={30}
            detail={t("admin.performance.completedDetail", { pct: d.completion_rate.toFixed(0) })}
          />
          <Component
            label={t("admin.performance.incentiveCol")}
            value={d.points_component}
            max={30}
            detail={formatMoney(d.rm_earned_this_month)}
          />
        </View>
      )}
    </Pressable>
  );
}

// ── Reliability lens — on-time % and completion % ────────────────────────
function Reliability({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const right = { textAlign: "right" as const, fontWeight: "700" as const };
  return (
    <Lens title={t("admin.performance.reliability")} hint={t("admin.performance.reliabilityHint")}>
      <TableHeader>
        <TableCell flex={1.6} header>{t("admin.performance.driver")}</TableCell>
        <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.onTime")}</TableCell>
        <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.completion")}</TableCell>
      </TableHeader>
      {drivers.map((d) => (
        <TableRow key={d.id}>
          <TableCell flex={1.6}><DriverCell d={d} /></TableCell>
          <TableCell flex={1} textStyle={right}>
            {d.total_completed > 0 ? `${d.on_time_rate.toFixed(0)}%` : "—"}
          </TableCell>
          <TableCell flex={1} textStyle={right}>
            {d.total_completed + d.total_cancelled > 0 ? `${d.completion_rate.toFixed(0)}%` : "—"}
          </TableCell>
        </TableRow>
      ))}
    </Lens>
  );
}

// ── Productivity lens — output volume ────────────────────────────────────
function Productivity({ drivers }: { drivers: DriverPerformance[] }) {
  const { t } = useTranslation();
  const right = { textAlign: "right" as const, fontWeight: "700" as const };
  return (
    <Lens title={t("admin.performance.productivity")} hint={t("admin.performance.productivityHint")}>
      <TableHeader>
        <TableCell flex={1.5} header>{t("admin.performance.driver")}</TableCell>
        <TableCell flex={0.8} header textStyle={{ textAlign: "right" }}>{t("admin.performance.tripsAll")}</TableCell>
        <TableCell flex={1.1} header textStyle={{ textAlign: "right" }}>{t("admin.performance.rmMonth")}</TableCell>
        <TableCell flex={0.9} header textStyle={{ textAlign: "right" }}>{t("admin.performance.distMonth")}</TableCell>
      </TableHeader>
      {drivers.map((d) => (
        <TableRow key={d.id}>
          <TableCell flex={1.5}><DriverCell d={d} /></TableCell>
          <TableCell flex={0.8} textStyle={right}>{d.total_completed}</TableCell>
          <TableCell flex={1.1} textStyle={right}>{formatMoney(d.rm_earned_this_month)}</TableCell>
          <TableCell flex={0.9} textStyle={right}>{`${Math.round(d.distance_km_this_month)} km`}</TableCell>
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
        : t("admin.performance.workloadImbalance", {
            most: most.name,
            mostCount: most.completed_this_month,
            least: least.name,
            leastCount: least.completed_this_month,
          });

  return (
    <Lens title={t("admin.performance.workload")} hint={t("admin.performance.workloadHint")}>
      <View
        style={{
          backgroundColor: uneven ? colors.orangeTint : colors.blueTint,
          borderRadius: radius.md,
          paddingVertical: 10,
          paddingHorizontal: 14,
          marginBottom: 16,
        }}
      >
        <Text style={{ color: uneven ? colors.orange : colors.blue, fontSize: font.sm, fontWeight: "600" }}>{note}</Text>
      </View>

      <View style={{ gap: 10 }}>
        {byLoad.map((d) => {
          const pct = max > 0 ? (d.completed_this_month / max) * 100 : 0;
          const isMost = max > 0 && d.completed_this_month === most.completed_this_month;
          return (
            <View key={d.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Text numberOfLines={1} style={{ width: 120, fontSize: font.sm, fontWeight: "600", color: colors.text }}>
                {d.name}
              </Text>
              <View style={{ flex: 1, backgroundColor: colors.divider, borderRadius: radius.pill, height: 22, overflow: "hidden" }}>
                <View
                  style={{
                    width: `${pct}%`,
                    minWidth: d.completed_this_month > 0 ? 24 : 0,
                    height: "100%",
                    backgroundColor: isMost ? colors.blue : "#7da7e0",
                    borderRadius: radius.pill,
                  }}
                />
              </View>
              <Text style={{ width: 28, textAlign: "right", fontSize: font.md, fontWeight: "800", color: colors.navy }}>
                {d.completed_this_month}
              </Text>
            </View>
          );
        })}
      </View>
    </Lens>
  );
}
