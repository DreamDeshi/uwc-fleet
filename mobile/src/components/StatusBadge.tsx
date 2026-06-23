import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, statusColors } from "../theme";
import { TripStatus } from "../types";

const LABEL_KEY: Record<TripStatus, string> = {
  pending: "trip.statusPending",
  approved: "trip.statusApproved",
  assigned: "trip.statusAssigned",
  in_progress: "trip.statusInProgress",
  completed: "trip.statusCompleted",
  rejected: "trip.statusRejected",
  cancelled: "trip.statusCancelled",
};

export function StatusBadge({ status, small }: { status: TripStatus; small?: boolean }) {
  const { t } = useTranslation();
  const c = statusColors[status] ?? statusColors.pending;
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: c.bg },
        small && { paddingVertical: 3, paddingHorizontal: 10 },
      ]}
    >
      <Text style={[styles.text, { color: c.fg }, small && { fontSize: 10 }]}>
        {t(LABEL_KEY[status] ?? "trip.statusPending").toUpperCase()}
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
  text: { fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
});
