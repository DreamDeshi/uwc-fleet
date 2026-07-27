// SDG visibility — the fleet's monthly fuel, CO₂e and distance, surfaced on
// the dashboard instead of buried in Trucks → Fuel. Same numbers as the Fuel
// tab headline (shared fleetFuelRollup over GET /trucks/fuel/summary);
// estimates are labelled as estimates. Read-only: no money, no dispatch.
import React from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useFuelSummary } from "../hooks/queries";
import { colors, font } from "../theme";
import { Card } from "./ui";
import { formatNumber } from "../lib/format";
import { fleetFuelRollup } from "../lib/fleetFuel";

export function SustainabilityCard({ onPress }: { onPress?: () => void }) {
  const { t } = useTranslation();
  const summary = useFuelSummary();
  // A dashboard widget must not add its own error noise — vanish on error.
  if (summary.isError) return null;
  const fleet = fleetFuelRollup(summary.data ?? []);
  const val = (s: string) => (fleet.hasData ? s : "—");

  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      <Pressable onPress={onPress} disabled={!onPress}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 16,
            backgroundColor: "#F0FDF4",
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: "#DCFCE7", alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="leaf" size={18} color="#16A34A" />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{t("admin.dashboard.sustainTitle")}</Text>
            <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.dashboard.sustainSub")}</Text>
          </View>
          {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} /> : null}
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, paddingVertical: 12, paddingHorizontal: 16 }}>
          <Stat value={val(`${formatNumber(fleet.litres)} L`)} label={t("admin.dashboard.sustainFuel")} />
          <Stat value={val(`${formatNumber(fleet.co2e)} kg`)} label={t("admin.dashboard.sustainCo2")} />
          <Stat value={val(`${formatNumber(fleet.km)} km`)} label={t("admin.dashboard.sustainDistance")} />
        </View>

        <Text style={{ fontSize: font.xs, color: colors.textFaint, paddingHorizontal: 16, paddingBottom: 10 }}>
          {t("admin.dashboard.sustainHint")}
        </Text>
      </Pressable>
    </Card>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, minWidth: 110 }}>
      <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>{value}</Text>
      <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}
