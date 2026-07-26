import React from "react";
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { TripsStackParamList } from "../../navigation/types";
import { useTrip, useUpdateTripStatus, useHolidaySet } from "../../hooks/queries";
import { apiErrorCode, apiErrorMessage } from "../../services/api";
import { colors, layout, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { StatusBadge } from "../../components/StatusBadge";
import { RouteLine } from "../../components/RouteLine";
import { LiveTripMap } from "../../components/LiveTripMap";
import { StatusTimeline } from "../../components/StatusTimeline";
import { LoadingState, ErrorState } from "../../components/States";
import { WebRefreshButton } from "../../components/WebRefreshButton";
import { formatMoney, formatDate, formatTime } from "../../lib/format";
import { incentiveAdjustment, tripMoneyState } from "../../lib/earnings";
import { buildPayBreakdown } from "../../lib/payBreakdown";
import { consigneeDestination } from "../../lib/geo";
import {
  tripDestination,
  tripDestZone,
  tripConsigneeName,
  cargoSummary,
  totalPallets,
  estimateIncentive,
  firstStop,
  consigneeAddress,
  ORIGIN_LABEL,
} from "../../lib/trip";

type Nav = NativeStackNavigationProp<TripsStackParamList, "TripDetails">;
type Rt = RouteProp<TripsStackParamList, "TripDetails">;

export function TripDetailsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);
  const startTrip = useUpdateTripStatus();
  const holidays = useHolidaySet();
  const [error, setError] = React.useState<string | null>(null);
  // Synchronous double-fire guard (web double-click lands before isPending
  // re-renders) — same pattern as ActiveTripScreen's oncePerAction.
  const startInFlight = React.useRef(false);

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const consignee = firstStop(trip)?.consignee;

  // Money display follows lib/earnings.ts's ruling: classification is on
  // STATUS, never on "an amount is present". `incentive_earned` is written at
  // PROPOSAL (delivery), so a pending_approval trip has an amount while the
  // money is still held — this screen used to turn it green forever, even
  // after an admin approved a DIFFERENT final figure. Now:
  //   final    → COALESCE(incentive_final, incentive_earned), green (the
  //              payable figure — same COALESCE payroll uses);
  //   awaiting → the proposed amount, "Awaiting approval" sub, not green;
  //   estimate → destination points × truck rate, "Estimated";
  //   none     → "—".
  const moneyState = tripMoneyState(trip);
  const estimate = moneyState === "estimate" ? estimateIncentive(trip, holidays) : null;
  // No estimate computable (missing truck/rate/zone) → "—", never a green
  // "RM 0" that reads as "this run pays nothing" (audit 2026-07-05 #5 —
  // same rule TripCard applies by hiding the row).
  const incentiveValue =
    moneyState === "final"
      ? formatMoney(trip.incentive_final ?? trip.incentive_earned)
      : moneyState === "awaiting"
        ? formatMoney(trip.incentive_earned)
        : estimate !== null
          ? formatMoney(estimate)
          : "—";
  const incentiveSub =
    moneyState === "awaiting"
      ? t("trip.awaitingApproval")
      : moneyState === "estimate" && estimate !== null
        ? t("trip.estimated")
        : undefined;
  const incentiveColor =
    moneyState === "final" && incentiveValue !== "—" ? colors.green : undefined;

  const onStart = async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setError(null);
    try {
      await startTrip.mutateAsync({ tripId: trip.id, action: "start" });
      navigation.replace("ActiveTrip", { tripId: trip.id });
    } catch (err) {
      // A committed-start-then-lost-response retry usually comes back as
      // 400 INVALID_STATUS ("Only assigned trips can be started" — the plain
      // pre-read fires before the CAS), and only the tight read-to-CAS race
      // returns TRIP_STATE_CHANGED. Reconcile BOTH: refetch, and if the trip
      // is out, proceed to the active screen exactly as if the tap had
      // succeeded (audit 2026-07-05 #7). The status===in_progress recheck is
      // what keeps this safe — a genuine refusal (admin unassigned it, or
      // another trip is already running) falls through to the error message
      // with the screen refreshed to the real state.
      const code = apiErrorCode(err);
      if (code === "TRIP_STATE_CHANGED" || code === "INVALID_STATUS") {
        const fresh = await refetch();
        if (fresh.data?.status === "in_progress") {
          navigation.replace("ActiveTrip", { tripId: trip.id });
          return;
        }
      }
      setError(apiErrorMessage(err));
    } finally {
      startInFlight.current = false;
    }
  };

  return (
    <View style={styles.fill}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Map header */}
        <View>
          {/* Route preview before the trip starts — no live dot yet (live={false}) */}
          <LiveTripMap
            tripId={trip.id}
            destZone={tripDestZone(trip)}
            destCoord={consigneeDestination(consignee).coord}
            live={false}
            height={190}
          />
          <TouchableOpacity
            style={[styles.backBtn, { top: insets.top + 8 }]}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="chevron-back" size={22} color={colors.navy} />
          </TouchableOpacity>
          <View style={[styles.badgeFloat, { top: insets.top + 8 }]}>
            <StatusBadge status={trip.status} />
          </View>
        </View>

        <View style={styles.body}>
          {/* Ticket + route type */}
          <View style={styles.chipsRow}>
            <View style={styles.ticketChip}>
              <Text style={styles.ticketChipText}>{trip.ticket_number}</Text>
            </View>
            {trip.route_type ? (
              <View style={styles.typeChip}>
                <Text style={styles.typeChipText}>{trip.route_type.name}</Text>
              </View>
            ) : null}
            {/* Browsers can't pull-to-refresh — web drivers resync here. */}
            <WebRefreshButton refreshing={isRefetching} onRefresh={refetch} />
          </View>

          {/* Route */}
          <Card style={{ marginBottom: 12 }}>
            <RouteLine
              from={ORIGIN_LABEL}
              to={tripConsigneeName(trip)}
              fromLabel={t("trip.pickup")}
              toLabel={t("trip.dropoff")}
            />
          </Card>

          {/* 3 info cards */}
          <View style={styles.infoRow}>
            <InfoCard icon="calendar-outline" label={t("trip.pickup")} value={formatDate(trip.pickup_datetime)} sub={formatTime(trip.pickup_datetime)} />
            <InfoCard icon="cube-outline" label={t("trip.cargo")} value={`${totalPallets(trip)}`} sub={t("booking.pallet")} />
            <InfoCard
              icon="cash-outline"
              label={t("trip.incentive")}
              value={incentiveValue}
              sub={incentiveSub}
              valueColor={incentiveColor}
            />
          </View>

          {/* Consignee */}
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.cardLabel}>{t("trip.consignee")}</Text>
            <Text style={styles.consigneeName}>{tripConsigneeName(trip)}</Text>
            {consignee?.contact_person ? (
              <Text style={styles.consigneeSub}>{consignee.contact_person}</Text>
            ) : null}
            {/* Full delivery address — this is the screen the driver reads
                BEFORE starting, so it is where the route gets planned. Falls
                back to area/state when the row has no street address. */}
            {consigneeAddress(consignee) ||
            [consignee?.area, consignee?.state].filter(Boolean).length > 0 ? (
              <Text style={styles.consigneeArea}>
                {consigneeAddress(consignee) ||
                  [consignee?.area, consignee?.state].filter(Boolean).join(", ")}
              </Text>
            ) : null}
            {consignee?.phone ? (
              <TouchableOpacity
                style={styles.phoneRow}
                activeOpacity={0.7}
                onPress={() => Linking.openURL(`tel:${consignee.phone}`)}
              >
                <View style={styles.phoneInfo}>
                  <Ionicons name="call-outline" size={16} color={colors.blue} />
                  <Text style={styles.phoneNumber}>{consignee.phone}</Text>
                </View>
                <View style={styles.callBtn}>
                  <Ionicons name="call" size={18} color={colors.white} />
                  <Text style={styles.callBtnText}>{t("trip.call")}</Text>
                </View>
              </TouchableOpacity>
            ) : null}
          </Card>

          {/* Requestor + truck */}
          <View style={styles.infoRow}>
            <Card style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>{t("trip.requestor")}</Text>
              <Text style={styles.smallStrong}>{trip.requestor?.name ?? "—"}</Text>
            </Card>
            <Card style={{ flex: 1 }}>
              <Text style={styles.cardLabel}>{t("trip.truck")}</Text>
              <Text style={styles.smallStrong}>{trip.truck_plate ?? "—"}</Text>
              <Text style={styles.smallMuted}>{trip.truck?.type ?? ""}</Text>
            </Card>
          </View>

          {/* Adaptive status timeline (from GET /trips/:id .timeline) */}
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.cardLabel}>{t("timeline.title")}</Text>
            <View style={{ marginTop: 4 }}>
              <StatusTimeline steps={trip.timeline ?? []} />
            </View>
          </Card>

          {/* Per-drop pay breakdown — the server's own finalize-time evidence
              (lib/payBreakdown.ts, pure + unit-tested), arranged so the RM in
              the InfoCard above RECONCILES: per-drop points (repeats marked),
              the daily deduction actually subtracted, and the RM/point rate.
              No RM is computed client-side. Null on unfinalized/legacy trips →
              the card doesn't render. */}
          {(() => {
            const breakdown = buildPayBreakdown(trip);
            if (!breakdown) return null;
            return (
              <Card style={{ marginBottom: 12 }}>
                <Text style={styles.cardLabel}>{t("trip.payBreakdownTitle")}</Text>
                <View style={{ marginTop: 8 }}>
                  {breakdown.rows.map((r) => (
                    <View key={r.stopId} style={styles.breakdownRow}>
                      <Text style={styles.breakdownName} numberOfLines={1}>
                        {r.sequence}. {r.name ?? "—"}
                        {r.wasRepeat ? ` ${t("trip.payBreakdownRepeat")}` : ""}
                      </Text>
                      <Text style={styles.breakdownPts}>
                        {t("trip.payBreakdownPts", { pts: r.points })}
                      </Text>
                    </View>
                  ))}
                  {breakdown.deduction !== null && breakdown.deduction > 0 ? (
                    <View style={styles.breakdownRow}>
                      <Text style={styles.breakdownName}>{t("trip.payBreakdownDeduction")}</Text>
                      <Text style={styles.breakdownPts}>
                        −{t("trip.payBreakdownPts", { pts: breakdown.deduction })}
                      </Text>
                    </View>
                  ) : null}
                  <View style={[styles.breakdownRow, styles.breakdownTotalRow]}>
                    <Text style={styles.breakdownTotalLabel}>{t("trip.payBreakdownTotal")}</Text>
                    <Text style={styles.breakdownTotalPts}>
                      {t("trip.payBreakdownPts", {
                        pts: breakdown.payablePoints ?? breakdown.totalPoints,
                      })}
                    </Text>
                  </View>
                  {breakdown.rate !== null ? (
                    <Text style={styles.breakdownRate}>
                      {t("trip.payBreakdownRate", { rate: breakdown.rate.toFixed(2) })}
                    </Text>
                  ) : null}
                  {moneyState === "awaiting" ? (
                    <Text style={styles.breakdownCaveat}>{t("trip.awaitingApproval")}</Text>
                  ) : null}
                </View>
              </Card>
            );
          })()}

          {/* Admin pay adjustment — the server REQUIRES a reason whenever the
              approved final differs from the proposal, but no driver screen
              ever showed it: the driver saw RM50 become RM40 with no
              explanation (money-review finding; the dispute Mr. Teh's R1
              email anticipates). Completed trips only (lib/earnings rule). */}
          {(() => {
            const adj = incentiveAdjustment(trip);
            if (!adj) return null;
            return (
              <Card style={{ marginBottom: 12 }}>
                <Text style={styles.cardLabel}>{t("trip.payAdjustedTitle")}</Text>
                <Text style={styles.adjustAmounts}>
                  {t("trip.payAdjustedAmounts", {
                    proposed: adj.proposed.toFixed(2),
                    final: adj.final.toFixed(2),
                  })}
                </Text>
                <Text style={styles.adjustReason}>
                  {adj.reason ?? t("trip.payAdjustedNoReason")}
                </Text>
              </Card>
            );
          })()}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </ScrollView>

      {/* Bottom action */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {trip.status === "assigned" ? (
          <Button
            title={t("trip.startTrip")}
            onPress={onStart}
            loading={startTrip.isPending}
            variant="success"
            size="xl"
            icon={<Ionicons name="play" size={20} color={colors.white} />}
          />
        ) : trip.status === "in_progress" ? (
          <Button
            title={t("trip.openMap")}
            onPress={() => navigation.navigate("ActiveTrip", { tripId: trip.id })}
            size="xl"
            icon={<Ionicons name="navigate" size={20} color={colors.white} />}
          />
        ) : null}
      </View>
    </View>
  );
}

function InfoCard({
  icon,
  label,
  value,
  sub,
  valueColor,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.infoCard}>
      <Ionicons name={icon} size={20} color={colors.blue} />
      <Text style={styles.infoLabel} numberOfLines={1}>{label}</Text>
      {/* Wrap to 2 lines: adjustsFontSizeToFit is a no-op on react-native-web,
          so a long date like "27 Jun 2026" was being truncated to "27 Jun 20…". */}
      <Text
        style={[styles.infoValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={2}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.infoSub} numberOfLines={1}>{sub ?? " "}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  backBtn: {
    position: "absolute",
    left: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  badgeFloat: { position: "absolute", right: 12 },
  body: { padding: 16, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  chipsRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" },
  ticketChip: { backgroundColor: colors.blue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.sm },
  ticketChipText: { color: colors.white, fontSize: 12, fontWeight: "700" },
  typeChip: { backgroundColor: colors.tintBlue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill },
  typeChipText: { color: colors.blue, fontSize: 12, fontWeight: "700" },
  infoRow: { flexDirection: "row", gap: 10, marginBottom: 12, alignItems: "stretch" },
  infoCard: { flex: 1, minHeight: 104, backgroundColor: colors.white, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center", justifyContent: "flex-start", ...shadow.card },
  infoLabel: { fontSize: 12, color: colors.textFaint, fontWeight: "600", textTransform: "uppercase", marginTop: 6, marginBottom: 4, textAlign: "center" },
  infoValue: { fontSize: 16, fontWeight: "800", color: colors.navy, textAlign: "center" },
  infoSub: { fontSize: 12, color: colors.textFaint, marginTop: 2, textAlign: "center" },
  cardLabel: { fontSize: 12, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  consigneeName: { fontSize: 15, fontWeight: "700", color: colors.navy },
  consigneeSub: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  consigneeArea: { fontSize: 13, color: colors.textFaint, marginTop: 2 },
  phoneRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.bg },
  phoneInfo: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  phoneNumber: { fontSize: 14, fontWeight: "700", color: colors.blue },
  callBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.green },
  callBtnText: { color: colors.white, fontSize: 14, fontWeight: "800" },
  smallStrong: { fontSize: 14, fontWeight: "700", color: colors.navy },
  smallMuted: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  breakdownRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 6 },
  breakdownName: { flex: 1, fontSize: 14, color: colors.textMuted },
  breakdownPts: { fontSize: 14, fontWeight: "700", color: colors.navy },
  breakdownTotalRow: { marginTop: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.bg },
  breakdownTotalLabel: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.navy },
  breakdownTotalPts: { fontSize: 14, fontWeight: "800", color: colors.navy },
  breakdownRate: { fontSize: 12, color: colors.textFaint, marginTop: 6 },
  // Neutral treatment: informative, not alarming (no red) and never green
  // (green = paid-as-proposed elsewhere).
  adjustAmounts: { fontSize: 14, fontWeight: "800", color: colors.navy },
  adjustReason: { fontSize: 13, color: colors.textMuted, marginTop: 6, lineHeight: 18 },
  // Muted, matching TripCard's awaiting treatment — never orange (offline-only
  // colour, owner ruling) and never green (green = paid).
  breakdownCaveat: { fontSize: 12, fontWeight: "700", color: colors.textMuted, marginTop: 4 },
  error: { color: colors.red, fontSize: 14, fontWeight: "600", marginTop: 8 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg, width: "100%", maxWidth: layout.content, alignSelf: "center" },
});
