// Lorry-fill visualiser (Mr. Teh's requirement) — RN port of the web admin's
// LoadCapacityBar: a segmented pallet bar showing how full a truck is right
// now; colour shifts as it approaches capacity.
import React from "react";
import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";

export function LoadCapacityBar({
  load,
  capacity,
  compact = false,
}: {
  load: number;
  capacity: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const pct = capacity > 0 ? Math.min(100, (load / capacity) * 100) : 0;
  const fillColor = pct >= 90 ? colors.red : pct >= 60 ? colors.orange : colors.green;
  const showSegments = !compact && capacity <= 16;

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Ionicons name="bus-outline" size={14} color={colors.textMuted} />
          <Text style={{ fontSize: font.xs, fontWeight: "600", color: colors.textMuted }}>
            {t("admin.dashboard.load")}
          </Text>
        </View>
        <Text style={{ fontSize: font.sm, fontWeight: "700", color: fillColor }}>
          {t("admin.dashboard.loadPallets", { load, capacity })}
        </Text>
      </View>

      {showSegments ? (
        <View style={{ flexDirection: "row", gap: 3 }}>
          {Array.from({ length: capacity }).map((_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: 14,
                borderRadius: 3,
                backgroundColor: i < load ? fillColor : colors.divider,
                borderWidth: 1,
                borderColor: i < load ? fillColor : colors.border,
              }}
            />
          ))}
        </View>
      ) : (
        <View style={{ backgroundColor: colors.divider, borderRadius: radius.pill, height: 12, overflow: "hidden" }}>
          <View style={{ width: `${pct}%`, height: "100%", backgroundColor: fillColor, borderRadius: radius.pill }} />
        </View>
      )}
    </View>
  );
}
