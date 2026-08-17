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
  // COMPACT drops the qualifier (design handoff, 17 Aug 2026): inside the trips
  // toolbar the pills sit next to the search box with no caption, and "Manual
  // Dispatch / Fully Automatic" spent ~90px restating a context the toolbar
  // already gives. The DASHBOARD keeps the full labels, where the control
  // stands alone under a "Dispatch mode" caption and the qualifier is the only
  // thing telling an admin that "automatic" means the server assigns on its
  // own — that is a consequential setting to shorten into ambiguity.
  const options: { value: DispatchMode; labelKey: string }[] = compact
    ? [
        { value: "manual", labelKey: "admin.dashboard.manualShort" },
        { value: "auto", labelKey: "admin.dashboard.autoShort" },
      ]
    : [
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
