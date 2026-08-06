import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, statusColors } from "../theme";
import { TripStatus } from "../types";
import { useAuth } from "../context/AuthContext";
import { statusLabelKey } from "../lib/statusLabel";

// The badge is shared by the driver's Trips list, the requestor's Bookings list
// and TripCard, so the same status reaches readers with opposite stakes in it.
// Which words each role gets is decided in lib/statusLabel.ts; the colour is
// NOT role-dependent and stays as theme.statusColors sets it.
export function StatusBadge({ status, small }: { status: TripStatus; small?: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const c = statusColors[status] ?? statusColors.pending;
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: c.bg },
        small && { paddingVertical: 3, paddingHorizontal: 10 },
      ]}
    >
      <Text style={[styles.text, { color: c.fg }, small && { fontSize: 12 }]}>
        {t(statusLabelKey(status, user?.role)).toUpperCase()}
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
});
