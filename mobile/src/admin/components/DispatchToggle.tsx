// Manual / Fully-Automatic dispatch toggle — RN port of the web admin's
// components/DispatchToggle.tsx on the same ported optimistic hook
// (lib/dispatchMode → useSetDispatchMode). Switching to "Fully Automatic"
// makes new bookings auto-assign the moment they're created (and the pending
// sweep auto-dispatches anything still pending).
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";
import { useDispatchMode, type DispatchMode } from "../lib/dispatchMode";

export function DispatchToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode, pending] = useDispatchMode();
  const options: { value: DispatchMode; labelKey: string }[] = [
    { value: "manual", labelKey: "admin.dashboard.manualDispatch" },
    { value: "auto", labelKey: "admin.dashboard.fullyAutomatic" },
  ];

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {!compact && (
        <Text style={{ fontSize: font.sm, fontWeight: "600", color: colors.textMuted }}>
          {t("admin.dashboard.dispatchMode")}
        </Text>
      )}
      <View
        style={{
          flexDirection: "row",
          backgroundColor: colors.panel,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.pill,
          padding: 3,
        }}
      >
        {options.map((o) => {
          const active = mode === o.value;
          return (
            <Pressable
              key={o.value}
              onPress={() => setMode(o.value)}
              disabled={pending}
              style={{
                paddingVertical: 7,
                paddingHorizontal: 14,
                borderRadius: radius.pill,
                opacity: pending ? 0.7 : 1,
                backgroundColor: active ? (o.value === "auto" ? colors.green : colors.blue) : "transparent",
              }}
            >
              <Text style={{ fontSize: font.sm, fontWeight: "700", color: active ? "#fff" : colors.textMuted }}>
                {t(o.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {mode === "auto" && (
        <Text style={{ fontSize: font.xs, color: colors.green, fontWeight: "600" }}>
          {t("admin.dashboard.engineActive")}
        </Text>
      )}
    </View>
  );
}
