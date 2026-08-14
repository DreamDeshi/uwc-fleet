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
import { pickupAge } from "../lib/attentionAge";
import type { AttentionReport, AttentionTrip, EarlyTapTrip } from "../types";

// Whether the panel will actually render — lets hosts skip wrapper spacing.
export function attentionHasRows(report?: AttentionReport): boolean {
  if (!report) return false;
  return (
    report.stale_in_progress.length > 0 ||
    report.overdue_assigned.length > 0 ||
    report.completed_null_incentive.length > 0 ||
    (report.assigned_driver_on_leave ?? []).length > 0 ||
    (report.early_tap_delivery ?? []).length > 0
  );
}

export function AttentionPanel({ report, onOpenBoard }: { report?: AttentionReport; onOpenBoard?: () => void }) {
  const { t } = useTranslation();
  if (!report) return null;
  // A row is TWO lines, and the first one decides whether to act: WHO has the
  // trip, in WHAT lorry, and HOW LONG it has been sitting. The ticket number
  // moves to the quiet second line — it was previously the largest, boldest
  // text in the panel and it is the one thing here that decides nothing; you
  // need it to talk about the trip, not to judge it.
  //
  // Each line is numberOfLines={1}. The old single wrapping string broke
  // wherever the width ran out, which routinely split a driver's name from the
  // plate beside it and left "Ahmad bin" ending one line and "Ismail · PNG 1234"
  // starting the next. A name and a lorry are single tokens to a reader.
  const defaultRow = (tr: AttentionTrip) => ({
    primary: [tr.driver?.name ?? "—", tr.truck_plate, pickupAge(tr.hours_since_pickup, tr.pickup_datetime, t)]
      .filter(Boolean)
      .join(" · "),
    secondary: tr.ticket_number,
  });
  const groups: {
    title: string;
    hint?: string;
    rows: AttentionTrip[];
    row?: (tr: AttentionTrip) => { primary: string; secondary: string };
  }[] = [
    {
      // ⚠ NO HINT ON THESE TWO. "(pickup > 8h ago, still not completed)" is the
      // WHERE clause of the query that built the group, not information: it
      // describes how the row was selected, which the group's own title already
      // says in words a dispatcher uses. The hints that survive below are the
      // ones that tell you something the title does not — that early-tap never
      // blocked anything, that a null incentive is a legacy artefact.
      title: t("admin.dashboard.attStale"),
      rows: report.stale_in_progress,
    },
    {
      title: t("admin.dashboard.attOverdue"),
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
    {
      // Early-tap review (detection only — the flag never blocked anything).
      title: t("admin.dashboard.attEarlyTap"),
      hint: t("admin.dashboard.attEarlyTapHint", { m: report.thresholds.earlyTapRadiusM ?? 500 }),
      rows: (report.early_tap_delivery ?? []) as AttentionTrip[],
      row: (tr: AttentionTrip) => {
        const et = tr as EarlyTapTrip;
        return {
          primary: t("admin.dashboard.attEarlyTapMeta", {
            driver: et.driver?.name ?? "—",
            consignee: et.consignee_name,
            m: et.distance_m,
          }),
          secondary: tr.ticket_number,
        };
      },
    },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0) return null;

  return (
    // ONE warning signal: the amber left edge.
    //
    // This card used to fire three at once — an orange edge, a warm tinted
    // panel and border, and orange group headings — plus a ⚠ in the title. Four
    // ways of saying "this is bad" do not make it four times as urgent; they
    // make the card loud everywhere and therefore emphatic nowhere, and they
    // leave nothing louder to escalate TO when something genuinely worse
    // appears. The edge marks the card; everything inside it is now ordinary
    // type, so the rows can be read rather than shouted.
    //
    // AMBER, NOT ORANGE, for the same reason as the approvals queue: orange is
    // reserved app-wide for offline/queued, and nothing in this panel is
    // offline — these trips are waiting on a person.
    <Card pad={0} style={{ borderLeftWidth: 5, borderLeftColor: colors.amber }}>
      <View style={{ paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
        <SectionTitle
          // No subtitle. "Trips needing attention" over "Stuck or stale trips"
          // said one thing twice, in a card whose whole problem is that it says
          // too much at once.
          title={t("admin.dashboard.attTitle")}
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
            {/* Navy, not orange — a group heading is structure, not an alarm. */}
            <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.navy, marginBottom: 4 }}>
              {g.title} · {g.rows.length}
              {g.hint ? <Text style={{ fontWeight: "500", color: colors.textFaint }}> ({g.hint})</Text> : null}
            </Text>
            {g.rows.slice(0, 5).map((tr) => {
              const { primary, secondary } = (g.row ?? defaultRow)(tr);
              return (
                <View key={(tr as EarlyTapTrip).stop_id ?? tr.id} style={{ paddingVertical: 4 }}>
                  <Text numberOfLines={1} style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>
                    {primary}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: font.xs, color: colors.textFaint, marginTop: 1 }}>
                    {secondary}
                  </Text>
                </View>
              );
            })}
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
