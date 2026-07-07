import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../theme";
import { StatusBadge } from "./StatusBadge";
import { useHolidaySet } from "../hooks/queries";
import { dayMonth, formatMoney } from "../lib/format";
import { tripDestination, estimateIncentive, ORIGIN_LABEL } from "../lib/trip";
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
  const { t } = useTranslation();
  const holidays = useHolidaySet();
  const dm = dayMonth(trip.pickup_datetime);
  const dim = trip.status === "cancelled" || trip.status === "rejected";
  // incentive_earned is null until the trip completes, so an assigned /
  // in-progress trip must show the "Est." estimate (mirroring the dashboard's
  // AssignmentCard) — never a bare green "RM 0", which reads as "this run pays
  // nothing". Cancelled/rejected trips pay nothing and show no amount at all.
  const finalized = trip.incentive_earned !== null && trip.incentive_earned !== undefined;
  const estimate = finalized || dim ? null : estimateIncentive(trip, holidays);
  const rmValue = finalized
    ? formatMoney(trip.incentive_earned)
    : estimate !== null
      ? formatMoney(estimate)
      : null;
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
        {showIncentive && rmValue !== null ? (
          <View style={styles.rmWrap}>
            {/* Estimated pay wears an amber chip so it can never be mistaken
                for the finalized green figure (driver design goal). */}
            {!finalized ? (
              <View style={styles.estChip}>
                <Text style={styles.est}>{t("trip.est")}</Text>
              </View>
            ) : null}
            <Text
              style={[
                styles.rm,
                !finalized && { color: colors.textMuted },
                dim && { color: colors.textFaint },
              ]}
            >
              {rmValue}
            </Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", backgroundColor: colors.white, borderRadius: radius.lg, overflow: "hidden", marginBottom: 10, ...shadow.card },
  dateBlock: { width: 56, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  dateDay: { color: colors.white, fontSize: 22, fontWeight: "800" },
  dateMon: { color: colors.yellow, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  cardBody: { flex: 1, padding: 12 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  route: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.navy },
  meta: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
  rmWrap: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 8 },
  estChip: {
    backgroundColor: colors.tintYellow,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  est: { fontSize: 12, fontWeight: "800", color: "#A16207", textTransform: "uppercase", letterSpacing: 0.4 },
  rm: { fontSize: 17, fontWeight: "800", color: colors.green },
});
