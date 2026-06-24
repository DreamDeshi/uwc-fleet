import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, radius, shadow } from "../theme";
import { StatusBadge } from "./StatusBadge";
import { dayMonth, formatMoney } from "../lib/format";
import { tripDestination, ORIGIN_LABEL } from "../lib/trip";
import { Trip } from "../types";

// Shared compact trip row — date block + route + status badge + optional meta
// line and incentive. One implementation replaces the near-identical cards that
// were duplicated across the driver dashboard and trip list (audit: 4 variants
// of the same card). The caller supplies the meta string so the same row works
// for both driver trips (ticket · cargo) and other contexts.
export function TripCard({
  trip,
  onPress,
  meta,
  showIncentive = false,
}: {
  trip: Trip;
  onPress: () => void;
  meta?: string;
  showIncentive?: boolean;
}) {
  const dm = dayMonth(trip.pickup_datetime);
  const dim = trip.status === "cancelled" || trip.status === "rejected";
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.card, dim && { opacity: 0.7 }]}
    >
      <View style={styles.dateBlock}>
        <Text style={styles.dateDay}>{dm.day}</Text>
        <Text style={styles.dateMon}>{dm.mon}</Text>
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.route} numberOfLines={1}>
            {ORIGIN_LABEL} → {tripDestination(trip)}
          </Text>
          <StatusBadge status={trip.status} small />
        </View>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {showIncentive ? (
          <Text style={[styles.rm, dim && { color: colors.textFaint }]}>
            {formatMoney(trip.incentive_earned)}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", backgroundColor: colors.white, borderRadius: radius.lg, overflow: "hidden", marginBottom: 10, ...shadow.card },
  dateBlock: { width: 56, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  dateDay: { color: colors.white, fontSize: 22, fontWeight: "800" },
  dateMon: { color: colors.yellow, fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  cardBody: { flex: 1, padding: 12 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  route: { flex: 1, fontSize: 13, fontWeight: "700", color: colors.navy },
  meta: { fontSize: 11, color: colors.textFaint, marginTop: 4 },
  rm: { fontSize: 15, fontWeight: "800", color: colors.green, marginTop: 8 },
});
