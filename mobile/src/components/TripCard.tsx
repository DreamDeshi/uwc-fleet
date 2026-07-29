import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../theme";
import { StatusBadge } from "./StatusBadge";
import { useHolidaySet } from "../hooks/queries";
import { dayMonth, formatMoney } from "../lib/format";
import { tripConsigneeName, estimateIncentive } from "../lib/trip";
import { tripMoneyState } from "../lib/earnings";
import { Trip } from "../types";

// The driver's trip row: a blue date block, where it went, what it was, and one
// status pill. Rebuilt to the approved design (driver screens, 29 Jul 2026).
//
// TWO DELIBERATE CHANGES FROM THE OLD CARD:
//
//  1. NO MONEY BY DEFAULT (`showIncentive` now defaults to false). Every trip
//     row used to carry an RM figure that repeated My Stats while obeying
//     different approval rules — an "Est." on an assigned trip, a proposal on a
//     delivered one. The design puts money on My Stats and Trip Details only.
//     The prop survives because the money treatment below is the audited one
//     (estimate vs proposal vs paid); nothing in the driver app passes it today.
//  2. The title is WHERE IT WENT, not "UWC Batu Kawan → X". Every trip starts
//     at the plant, so the origin was 14 identical characters in front of the
//     only word that told them apart.
export function TripCard({
  trip,
  onPress,
  meta,
  showIncentive = false,
  continueLabel,
  onContinue,
}: {
  trip: Trip;
  onPress: () => void;
  meta?: string;
  showIncentive?: boolean;
  /** Live trip only: the pinned "Continue · stop 2 of 5" action. */
  continueLabel?: string;
  onContinue?: () => void;
}) {
  const { t } = useTranslation();
  const holidays = useHolidaySet();
  const dm = dayMonth(trip.pickup_datetime);
  const dim = trip.status === "cancelled" || trip.status === "rejected";

  // MONEY: classification is on STATUS, never on "an amount is present".
  // `incentive_earned` is written at PROPOSAL (delivery), so a pending_approval
  // trip HAS an amount while the money is still held. The decision lives in
  // lib/earnings (pure, unit-tested) — an untestable money rule is exactly how
  // the earlier bug survived.
  const money = tripMoneyState(trip);
  const awaiting = money === "awaiting";
  const finalized = money === "final";
  // No estimate for an awaiting trip: it already HAS a real proposed figure, and
  // re-estimating would show a different number than the one under review.
  const estimate = money === "estimate" ? estimateIncentive(trip, holidays) : null;
  const rmValue =
    finalized || awaiting
      ? formatMoney(trip.incentive_earned)
      : estimate !== null
        ? formatMoney(estimate)
        : null;

  return (
    <View style={[styles.card, dim && { opacity: 0.7 }]}>
      <TouchableOpacity style={styles.hit} activeOpacity={0.85} onPress={onPress}>
        <View style={styles.dateBlock}>
          <Text style={styles.dateDay}>{dm.day}</Text>
          <Text style={styles.dateMon}>{dm.mon}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.title} numberOfLines={2}>
            {tripConsigneeName(trip)}
          </Text>
          {meta ? <Text style={styles.meta} numberOfLines={2}>{meta}</Text> : null}
          <View style={styles.badgeRow}>
            <StatusBadge status={trip.status} small />
          </View>
          {showIncentive && rmValue !== null ? (
            <View style={styles.rmWrap}>
              {/* Any non-final figure wears a chip so it can never be mistaken
                  for the finalized one. Amber "Est." = a guess before delivery;
                  GREY "Awaiting approval" = a real proposed amount an admin has
                  not signed off. Grey, not orange — orange is offline/queued. */}
              {!finalized ? (
                <View style={[styles.estChip, awaiting && styles.awaitingChip]}>
                  <Text style={[styles.est, awaiting && styles.awaitingText]}>
                    {awaiting ? t("trip.awaitingApproval") : t("trip.est")}
                  </Text>
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

          {continueLabel && onContinue ? (
            <TouchableOpacity style={styles.continue} onPress={onContinue} activeOpacity={0.85}>
              <Ionicons name="navigate" size={17} color={colors.white} />
              <Text style={styles.continueText} numberOfLines={1}>{continueLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
    marginBottom: 9,
    ...shadow.card,
  },
  hit: { flexDirection: "row" },
  dateBlock: { width: 56, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", paddingVertical: 16 },
  dateDay: { color: colors.white, fontSize: 22, fontWeight: "800" },
  dateMon: { color: colors.yellow, fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  cardBody: { flex: 1, paddingVertical: 12, paddingHorizontal: 14 },
  title: { fontSize: 16, fontWeight: "800", color: colors.navy, lineHeight: 21 },
  // textMuted, not textFaint — this line carries the stop and pallet counts.
  meta: { fontSize: 12, fontWeight: "600", color: colors.textMuted, marginTop: 4 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 9 },
  rmWrap: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 8 },
  estChip: { backgroundColor: colors.tintYellow, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  est: { fontSize: 12, fontWeight: "800", color: "#A16207", textTransform: "uppercase", letterSpacing: 0.4 },
  awaitingChip: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  awaitingText: { color: colors.textMuted },
  rm: { fontSize: 17, fontWeight: "800", color: colors.greenText },
  continue: {
    minHeight: 44,
    marginTop: 11,
    borderRadius: radius.md,
    backgroundColor: colors.blue,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  continueText: { color: colors.white, fontSize: 14, fontWeight: "800" },
});
