// Top-level Sustainability screen (owner ask, 27 Jul 2026). The fuel/CO₂e
// figures were split between a buried Trucks → Fuel tab and a dashboard tile;
// this screen absorbs both and becomes the ONE view of that data:
//   - fleet hero: fuel used / est. CO₂e / distance / fleet L/100km, this month
//   - right-sizing savings: the "≈ X L saved" figure with its trip count
//   - per-truck breakdown: the existing FuelPanel (its old fleet headline
//     strip removed — the hero above owns the fleet figures now)
// NO math is re-implemented here: every figure comes from the existing
// hooks/libs (useFuelSummary + fleetFuelRollup, useConsolidationSavings →
// rightSizing, FuelPanel/summariseFuel). Estimates stay labelled as estimates.
//
// Empty vs broken are DISTINCT states: a fetch failure shows ErrorState with
// retry; zero logged fill-ups shows the friendly empty card (that is why the
// figures read "—" on a fresh deployment — prod has no fuel logs yet).
import React, { useState } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useConsolidationSavings, useFuelSummary } from "../hooks/queries";
import { colors, font, radius, status } from "../theme";
import { Button, Card, ErrorState, Loading, SectionTitle } from "../components/ui";
import { formatNumber } from "../lib/format";
import { fleetFuelRollup } from "../lib/fleetFuel";
import { buildFuelLogsCsv, buildFuelSummaryCsv, type FuelLogExportRow } from "../lib/fuelCsv";
import { CSV_BOM } from "../lib/csv";
import { shareCsv } from "../platform/csvShare";
import { api } from "../services/api";
import { FuelPanel } from "../components/FuelPanel";
import { useLayoutMode } from "../hooks/useLayoutMode";

export function SustainabilityScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const wide = mode === "wide";
  const summary = useFuelSummary();
  const consolidation = useConsolidationSavings();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  // CSV exports — SEPARATE single-purpose files (owner direction, 27 Jul):
  // a fills ledger and a per-truck monthly summary, both Excel-first
  // (BOM + injection-guarded cells, lib/fuelCsv). Web-only, like the
  // payroll export (the native shareCsv path is a deliberate stub).
  const exportSummary = async () => {
    setExportError(false);
    try {
      const month = new Date().toISOString().slice(0, 7);
      await shareCsv(`uwc-fuel-summary-${month}.csv`, CSV_BOM + buildFuelSummaryCsv(summary.data ?? []));
    } catch {
      setExportError(true);
    }
  };
  const exportFills = async () => {
    setExportError(false);
    setExporting(true);
    try {
      const res = await api.get<{ month: string; logs: FuelLogExportRow[] }>("/trucks/fuel/logs");
      await shareCsv(`uwc-fuel-fills-${res.data.month}.csv`, CSV_BOM + buildFuelLogsCsv(res.data.logs));
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };

  if (summary.isLoading) return <Loading />;
  if (summary.isError) {
    return <ErrorState message={t("admin.sustainability.loadError")} onRetry={() => summary.refetch()} />;
  }

  const fleet = fleetFuelRollup(summary.data ?? []);
  const rs = consolidation.data?.rightSizing;
  const val = (s: string) => (fleet.hasData ? s : "—");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={summary.isRefetching}
          onRefresh={() => {
            summary.refetch();
            consolidation.refetch();
          }}
        />
      }
    >
      {/* Frame 11's hero: the month, the ONE headline figure, and the rest of
          the rollup on a single line beneath it. ⚠ It shows "—", never "0 L
          used", when nothing has been logged — a confident zero here is a false
          claim about fuel, and on a fresh deployment (prod today) that is
          exactly the state. The empty card below says why. */}
      <FuelHero fleet={fleet} />

      {/* Frame 11 stacks the four metrics one per row on the phone. Wide keeps
          them 4-up — that layout is not what the frame draws and the desktop
          has the width for it. */}
      <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 12 }}>
        <HeroStat icon="water-outline" value={val(`${formatNumber(fleet.litres)} L`)} label={t("admin.sustainability.fuelUsed")} />
        <HeroStat icon="leaf-outline" value={val(`${formatNumber(fleet.co2e)} kg`)} label={t("admin.sustainability.estCo2e")} />
        <HeroStat icon="speedometer-outline" value={val(`${formatNumber(fleet.km)} km`)} label={t("admin.sustainability.distance")} />
        <HeroStat
          icon="analytics-outline"
          value={fleet.lp100 != null ? formatNumber(fleet.lp100) : "—"}
          label={t("admin.sustainability.fleetL100")}
        />
      </View>
      {/* The estimates footnote owns its line. It used to share a row with the
          export buttons, which wrapped and left the caption stranded. */}
      <Text style={{ fontSize: font.xs, color: colors.textFaint, marginTop: -6 }}>
        {t("admin.sustainability.estimatesNote")}
      </Text>
      {/* Web-only, and deliberately so — the native share path is a stub. The
          frame draws no buttons here because a phone never renders them. */}
      {Platform.OS === "web" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: -4 }}>
          <Button size="sm" variant="outline" onPress={exportFills} disabled={exporting}>
            {t("admin.sustainability.exportFills")}
          </Button>
          <Button size="sm" variant="outline" onPress={exportSummary}>
            {t("admin.sustainability.exportSummary")}
          </Button>
        </View>
      )}
      {exportError ? (
        <Text style={{ fontSize: font.sm, color: colors.red, marginTop: -8 }}>{t("admin.sustainability.exportFailed")}</Text>
      ) : null}

      {/* Why the dashes: no fill-ups yet is EMPTY, not broken. */}
      {!fleet.hasData && (
        <Card style={{ backgroundColor: "#F0FDF4", borderColor: "#BBE5C8" }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Ionicons name="information-circle-outline" size={18} color={status.success.solid} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>
                {t("admin.sustainability.emptyTitle")}
              </Text>
              <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 3 }}>
                {t("admin.sustainability.emptyBody")}
              </Text>
            </View>
          </View>
        </Card>
      )}

      {/* Right-sizing savings — the smallest-fit dispatch estimate. */}
      <Card>
        <SectionTitle title={t("admin.sustainability.savingsTitle")} subtitle={t("admin.sustainability.savingsSub")} />
        {rs && rs.tripsRightSized > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: radius.md,
                backgroundColor: "#DCFCE7",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="trending-down" size={22} color={status.success.solid} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 30, fontWeight: "900", color: "#166534", letterSpacing: -0.5 }}>
                ≈ {formatNumber(rs.estLitresSaved)} L
              </Text>
              <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 1 }}>
                {t("admin.sustainability.savingsMeta", {
                  count: rs.tripsRightSized,
                  co2: formatNumber(rs.estCo2eKgSaved),
                })}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.sustainability.savingsNone")}</Text>
        )}
      </Card>

      {/* Per-truck breakdown — the useful part of the old Trucks → Fuel tab
          (cost, L/100km, litres, expandable fill-up logs, admin Log Fuel). */}
      <FuelPanel />

      <Text style={{ fontSize: font.xs, color: colors.textFaint }}>{t("admin.sustainability.disclosure")}</Text>
    </ScrollView>
  );
}

function HeroStat({
  icon,
  value,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  label: string;
}) {
  return (
    <Card pad={16} style={{ flex: 1, minWidth: 150 }}>
      {/* Frame 11: the icon is a pale-green CHIP on its own row above the
          label, not a glyph sitting inline beside it. */}
      <View style={sus.chip}>
        <Ionicons name={icon} size={18} color={colors.green} />
      </View>
      <Text style={sus.statLabel}>{label}</Text>
      <Text style={sus.statValue}>{value}</Text>
    </Card>
  );
}

// ── Frame 11 hero ─────────────────────────────────────────────────────
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

function FuelHero({ fleet }: { fleet: ReturnType<typeof fleetFuelRollup> }) {
  const { t } = useTranslation();
  const now = new Date();
  // ⚠ Built from an i18n month table, NOT Intl/toLocaleDateString. Hermes ships
  // a cut-down Intl, so a locale-formatted month works on web and silently
  // degrades on the device — the one place this would never be noticed.
  const month = t(`admin.months.${MONTH_KEYS[now.getMonth()]}`);

  return (
    <View style={sus.hero}>
      {/* Decorative only; pointerEvents off so it can never eat a tap. */}
      <View style={sus.heroDisc} pointerEvents="none" />
      <Text style={sus.heroMonth}>{t("admin.sustainability.heroMonth", { month, year: now.getFullYear() })}</Text>
      <Text style={sus.heroValue}>
        {fleet.hasData ? t("admin.sustainability.heroUsed", { litres: formatNumber(fleet.litres) }) : "—"}
      </Text>
      {fleet.hasData && (
        <Text style={sus.heroRollup}>
          {t("admin.sustainability.heroRollup", {
            co2: formatNumber(fleet.co2e),
            km: formatNumber(fleet.km),
            lp100: fleet.lp100 != null ? formatNumber(fleet.lp100) : "—",
          })}
        </Text>
      )}
    </View>
  );
}

const sus = StyleSheet.create({
  hero: {
    backgroundColor: colors.greenDeep,
    borderRadius: radius.lg,
    paddingVertical: 20,
    paddingHorizontal: 20,
    overflow: "hidden",
  },
  heroDisc: {
    position: "absolute",
    top: -46,
    right: -30,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  heroMonth: { fontSize: font.xs, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: "rgba(255,255,255,0.72)" },
  heroValue: { fontSize: 32, fontWeight: "800", color: "#fff", marginTop: 6, letterSpacing: -0.4 },
  heroRollup: { fontSize: font.sm, color: "rgba(255,255,255,0.82)", marginTop: 6 },
  chip: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.greenTint,
    alignItems: "center",
    justifyContent: "center",
  },
  statLabel: {
    fontSize: font.xs,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 12,
  },
  statValue: { fontSize: 24, fontWeight: "800", color: colors.navy, marginTop: 4 },
});
