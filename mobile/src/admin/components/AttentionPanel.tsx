// Stuck/stale trips (read-only attention report) — port of the web
// dashboard's AttentionPanel, extracted from DashboardWide so the mobile
// Home (bottom-tab shell) can show the same panel. Renders nothing when the
// fleet is healthy. The "open trip board" link stays dimmed unless the host
// screen passes onOpenBoard (mobile deep-links it to the Trips tab; the PC
// dashboard passes nothing and looks exactly as before).
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, font } from "../theme";
import { Card, SectionTitle } from "./ui";
import type { AttentionReport, AttentionTrip } from "../types";

// Whether the panel will actually render — lets hosts skip wrapper spacing.
export function attentionHasRows(report?: AttentionReport): boolean {
  if (!report) return false;
  return (
    report.stale_in_progress.length > 0 ||
    report.overdue_assigned.length > 0 ||
    report.completed_null_incentive.length > 0 ||
    (report.assigned_driver_on_leave ?? []).length > 0
  );
}

export function AttentionPanel({ report, onOpenBoard }: { report?: AttentionReport; onOpenBoard?: () => void }) {
  const { t } = useTranslation();
  if (!report) return null;
  const groups: { title: string; hint: string; rows: AttentionTrip[] }[] = [
    {
      title: t("admin.dashboard.attStale"),
      hint: t("admin.dashboard.attStaleHint", { h: report.thresholds.staleInProgressHours }),
      rows: report.stale_in_progress,
    },
    {
      title: t("admin.dashboard.attOverdue"),
      hint: t("admin.dashboard.attOverdueHint", { h: report.thresholds.overdueAssignedHours }),
      rows: report.overdue_assigned,
    },
    {
      title: t("admin.dashboard.attNullIncentive"),
      hint: t("admin.dashboard.attNullIncentiveHint"),
      rows: report.completed_null_incentive,
    },
    {
      title: t("admin.dashboard.attOnLeave"),
      hint: t("admin.dashboard.attOnLeaveHint"),
      rows: report.assigned_driver_on_leave ?? [],
    },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;

  return (
    <Card pad={0} style={{ borderColor: "#FFD9A8", borderLeftWidth: 5, borderLeftColor: colors.orange, backgroundColor: "#FFFDF8" }}>
      <View style={{ paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: "#FBE7CC" }}>
        <SectionTitle
          title={t("admin.dashboard.attTitle")}
          subtitle={t("admin.dashboard.attSub")}
          right={
            onOpenBoard ? (
              <Pressable onPress={onOpenBoard} hitSlop={8}>
                <Text style={{ color: colors.blue, fontSize: font.sm, fontWeight: "700" }}>
                  {t("admin.dashboard.openTripBoard")}
                </Text>
              </Pressable>
            ) : (
              // PC: dimmed until the wide dashboard wires its own deep link.
              <Text style={{ color: colors.blue, fontSize: font.sm, fontWeight: "700", opacity: 0.45 }}>
                {t("admin.dashboard.openTripBoard")}
              </Text>
            )
          }
        />
      </View>
      <View style={{ paddingTop: 10, paddingHorizontal: 18, paddingBottom: 16, gap: 12 }}>
        {groups.map((g) => (
          <View key={g.title}>
            <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.orange, marginBottom: 4 }}>
              {g.title} · {g.rows.length}
              <Text style={{ fontWeight: "500", color: colors.textFaint }}> ({g.hint})</Text>
            </Text>
            {g.rows.slice(0, 5).map((tr) => (
              <View key={tr.id} style={{ flexDirection: "row", gap: 8, paddingVertical: 3, flexWrap: "wrap" }}>
                <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>{tr.ticket_number}</Text>
                <Text style={{ fontSize: font.sm, color: colors.textMuted, flexShrink: 1 }}>
                  {tr.driver?.name ?? "—"}
                  {tr.truck_plate ? ` · ${tr.truck_plate}` : ""} ·{" "}
                  {t(
                    tr.hours_since_pickup >= 0 ? "admin.dashboard.sincePickup" : "admin.dashboard.untilPickup",
                    { h: Math.abs(Math.round(tr.hours_since_pickup)) }
                  )}
                </Text>
              </View>
            ))}
            {g.rows.length > 5 && (
              <Text style={{ fontSize: font.sm, color: colors.textFaint }}>
                {t("admin.dashboard.andMore", { count: g.rows.length - 5 })}
              </Text>
            )}
          </View>
        ))}
      </View>
    </Card>
  );
}
