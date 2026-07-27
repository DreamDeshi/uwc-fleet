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
import React from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useConsolidationSavings, useFuelSummary } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Card, ErrorState, Loading, SectionTitle } from "../components/ui";
import { formatNumber } from "../lib/format";
import { fleetFuelRollup } from "../lib/fleetFuel";
import { FuelPanel } from "../components/FuelPanel";
import { useLayoutMode } from "../hooks/useLayoutMode";

export function SustainabilityScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const wide = mode === "wide";
  const summary = useFuelSummary();
  const consolidation = useConsolidationSavings();

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
      {/* Fleet hero — 4-up on wide, 2×2 on phone (minWidth wraps them). */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <HeroStat icon="water-outline" value={val(`${formatNumber(fleet.litres)} L`)} label={t("admin.sustainability.fuelUsed")} />
        <HeroStat icon="leaf-outline" value={val(`${formatNumber(fleet.co2e)} kg`)} label={t("admin.sustainability.estCo2e")} />
        <HeroStat icon="speedometer-outline" value={val(`${formatNumber(fleet.km)} km`)} label={t("admin.sustainability.distance")} />
        <HeroStat
          icon="analytics-outline"
          value={fleet.lp100 != null ? formatNumber(fleet.lp100) : "—"}
          label={t("admin.sustainability.fleetL100")}
        />
      </View>
      <Text style={{ fontSize: font.xs, color: colors.textFaint, marginTop: -8 }}>{t("admin.sustainability.heroCaption")}</Text>

      {/* Why the dashes: no fill-ups yet is EMPTY, not broken. */}
      {!fleet.hasData && (
        <Card style={{ backgroundColor: "#F0FDF4", borderColor: "#BBE5C8" }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Ionicons name="information-circle-outline" size={18} color="#16A34A" />
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
              <Ionicons name="trending-down" size={22} color="#16A34A" />
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
    <Card pad={14} style={{ flex: 1, minWidth: 150 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Ionicons name={icon} size={15} color="#16A34A" />
        <Text style={{ fontSize: font.xs, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {label}
        </Text>
      </View>
      <Text style={{ fontSize: 24, fontWeight: "800", color: colors.text }}>{value}</Text>
    </Card>
  );
}
