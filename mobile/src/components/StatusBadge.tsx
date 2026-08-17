import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, statusColors } from "../theme";
import { useOutdoor } from "../context/OutdoorContext";
import { outdoor, outdoorFillFor } from "../lib/outdoorMode";
import { TripStatus } from "../types";
import { useAuth } from "../context/AuthContext";
import { statusLabelKey } from "../lib/statusLabel";

// The badge is shared by the driver's Trips list, the requestor's Bookings list
// and TripCard, so the same status reaches readers with opposite stakes in it.
// Which words each role gets is decided in lib/statusLabel.ts; the colour is
// NOT role-dependent and stays as theme.statusColors sets it.
export function StatusBadge({
  status,
  small,
  label,
}: {
  status: TripStatus;
  small?: boolean;
  /** Overrides the words only — the COLOUR still comes from `status`, so a
   *  derived label ("Arrived", which is not a TripStatus) cannot invent a hue
   *  the dispatcher's board does not use for the same booking. */
  label?: string;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { outdoorOn } = useOutdoor();

  // ⚠ THE OVERRIDE LIVES HERE, NOT IN THE TOKEN (owner ruling, 17 Aug 2026).
  // `statusColors` is shared with the REQUESTOR, so re-pointing the token would
  // drag her palette into a driver's sunlight preference for no reason. The
  // badge is the narrowest place that still fixes every list that renders one.
  //
  // Outdoors: a SOLID fill carrying white at ≥ 7:1, and a heavier label. The
  // indoor pairs are white-on-brand at about 5:1, which is roughly 2.6:1 under
  // moderate glare — legible in an office, not at a gate.
  const indoor = statusColors[status] ?? statusColors.pending;
  const c = outdoorOn
    ? { bg: outdoor.fill[outdoorFillFor(status)], fg: colors.white }
    : indoor;
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: c.bg },
        small && { paddingVertical: 3, paddingHorizontal: 10 },
      ]}
    >
      <Text style={[styles.text, { color: c.fg }, outdoorOn && styles.textOutdoor, small && { fontSize: 12 }]}>
        {(label ?? t(statusLabelKey(status, user?.role))).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  text: { fontSize: 12, fontWeight: "800", letterSpacing: 0.4 },
  // Weight and tracking do more outdoors than hue does — a thin glyph loses to
  // glare long before its contrast ratio does.
  textOutdoor: { fontSize: 13, fontWeight: "900", letterSpacing: 0.6 },
});
