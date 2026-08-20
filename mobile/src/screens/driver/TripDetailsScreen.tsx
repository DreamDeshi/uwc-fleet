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
import { DELIVERED_STATUSES } from "../../lib/tripStatus";
import { shouldReconcileStart } from "../../lib/startTrip";
import { estimateTripCo2 } from "../../lib/tripCo2";
import { consigneeDestination } from "../../lib/geo";
import { formatPalletSpaces } from "../../lib/pallets";
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
  // All stops in booking order. The order is a SUGGESTION only (Mr. Teh,
  // 28 Jul 2026: "driver no need follow route order") — the multi-stop card
  // says so and gives every stop its own address + call affordance, where the
  // old screen showed stop 1 alone.
  const stops = (trip.stops ?? []).slice().sort((a, b) => a.sequence - b.sequence);
  const multiStop = stops.length > 1;

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
  // greenText, not green: this is a FIGURE, and `green` on white is 3:1 — short
  // of the 4.5:1 a driver needs reading pay in sunlight. Status pills keep the
  // fill colour.
  const incentiveColor =
    moneyState === "final" && incentiveValue !== "—" ? colors.greenText : undefined;

  const onStart = async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setError(null);
    try {
      await startTrip.mutateAsync({ tripId: trip.id, action: "start" });
      navigation.replace("ActiveTrip", { tripId: trip.id });
    } catch (err) {
      // Reconcile a committed-then-lost start (audit 2026-07-05 #7). The rule
      // itself lives in lib/startTrip so Home's "Start this trip" — the second
      // entry point the approved design adds — behaves identically.
      if (shouldReconcileStart(apiErrorCode(err))) {
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
              to={
                multiStop
                  ? t("trip.multiDest", { name: tripConsigneeName(trip), n: stops.length - 1 })
                  : tripConsigneeName(trip)
              }
              fromLabel={t("trip.pickup")}
              toLabel={t("trip.dropoff")}
            />
          </Card>

          {/* 3 info cards */}
          <View style={styles.infoRow}>
            <InfoCard icon="calendar-outline" label={t("trip.pickup")} value={formatDate(trip.pickup_datetime)} sub={formatTime(trip.pickup_datetime)} />
            <InfoCard icon="cube-outline" label={t("trip.cargo")} value={t("driver.palletCount", { spaces: formatPalletSpaces(totalPallets(trip)) })} />
            <InfoCard
              icon="cash-outline"
              label={t("trip.incentive")}
              value={incentiveValue}
              sub={incentiveSub}
              valueColor={incentiveColor}
            />
          </View>

          {/* Consignee(s). Single-stop keeps the classic card; a multi-stop
              trip lists EVERY stop — name, contact, address, its own call
              button — where the old screen showed stop 1 alone (DG-D3). */}
          {multiStop ? (
            <Card style={{ marginBottom: 12 }}>
              <Text style={styles.cardLabel}>
                {t("trip.stops")} ({stops.length})
              </Text>
              <Text style={styles.stopOrderHint}>{t("trip.stopOrderHint")}</Text>
              {stops.map((s, i) => {
                const addr =
                  consigneeAddress(s.consignee) ||
                  [s.consignee?.area, s.consignee?.state].filter(Boolean).join(", ");
                return (
                  <View key={s.id} style={[styles.stopRow, i > 0 && styles.stopRowBorder]}>
                    <View style={styles.stopSeq}>
                      <Text style={styles.stopSeqText}>{i + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.consigneeName}>
                        {s.consignee?.company_name ?? t("trip.stop", { n: i + 1 })}
                      </Text>
                      {s.consignee?.contact_person ? (
                        <Text style={styles.consigneeSub}>{s.consignee.contact_person}</Text>
                      ) : null}
                      {addr ? <Text style={styles.consigneeArea}>{addr}</Text> : null}
                    </View>
                    {s.consignee?.phone ? (
                      <TouchableOpacity
                        style={styles.callBtnRound}
                        activeOpacity={0.7}
                        hitSlop={8}
                        accessibilityLabel={t("trip.call")}
                        onPress={() => Linking.openURL(`tel:${s.consignee!.phone}`)}
                      >
                        <Ionicons name="call" size={18} color={colors.white} />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          ) : (
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
          )}

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
                  {/* R5 A2 (IM10) — the line that explains RM0. Interplant pays
                      per COMPLETED ROUND TRIP, so the day's first leg earns
                      nothing and the pay lands on the return. Without this row
                      the card shows a delivered stop worth points and a total of
                      zero, which reads as the system having lost his money. It
                      renders only when something was actually withheld, so no
                      customer/supplier trip ever grows a line about interplant
                      rules. */}
                  {breakdown.roundTripShortfall !== null && breakdown.roundTripShortfall > 0 ? (
                    <View style={styles.breakdownRow}>
                      <Text style={styles.breakdownName}>{t("trip.payBreakdownRoundTripHeld")}</Text>
                      <Text style={styles.breakdownPts}>
                        −{t("trip.payBreakdownPts", { pts: breakdown.roundTripShortfall })}
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

          {/* Per-trip CO₂e ESTIMATE (SDG visibility) — completed trips only,
              labelled as an estimate; lib/tripCo2 mirrors the api's
              display-only constants. Never pay-related. */}
          {(() => {
            if (!DELIVERED_STATUSES.includes(trip.status)) return null;
            const co2 = estimateTripCo2(trip.stops ?? []);
            if (!co2) return null;
            return (
              <View style={styles.co2Row}>
                <Ionicons name="leaf-outline" size={14} color={colors.greenText} />
                <Text style={styles.co2Text}>
                  {t("trip.co2Estimate", { km: co2.km, kg: co2.co2Kg })}
                </Text>
              </View>
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
  // ⚠ zIndex is load-bearing on WEB and cannot be replaced by `elevation`.
  // This button floats over LiveTripMap, which on web is a real Leaflet map,
  // and Leaflet's own CSS gives its panes z-index 200–800. RN-Web compiles the
  // `elevation: 3` inside shadow.card to a box-shadow, NOT a stacking order, so
  // without an explicit zIndex the map painted straight over the button and the
  // driver had no visible way back out of a trip he opened from his history.
  // ActiveTripScreen's identical overlay escaped it only because its web map is
  // a placeholder, not Leaflet — so the bug reproduced on ONE screen and read
  // like a styling one-off.
  backBtn: {
    position: "absolute",
    left: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
    ...shadow.card,
  },
  // Same stacking context as backBtn — the status badge was buried too.
  badgeFloat: { position: "absolute", right: 12, zIndex: 1 },
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
  // The delivery address is the human backstop for a wrong pin — the driver
  // reads it to find the place. textFaint on white is 2.5:1, so it steps up to
  // textMuted (approved contrast pass).
  consigneeArea: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  stopOrderHint: { fontSize: 13, color: colors.textMuted, marginBottom: 4, lineHeight: 18 },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  stopRowBorder: { borderTopWidth: 1, borderTopColor: colors.bg },
  stopSeq: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  stopSeqText: { color: colors.blue, fontWeight: "800", fontSize: 13 },
  callBtnRound: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" },
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
  co2Row: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12, paddingHorizontal: 2 },
  co2Text: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  // Muted, matching TripCard's awaiting treatment — never orange (offline-only
  // colour, owner ruling) and never green (green = paid).
  breakdownCaveat: { fontSize: 12, fontWeight: "700", color: colors.textMuted, marginTop: 4 },
  error: { color: colors.red, fontSize: 14, fontWeight: "600", marginTop: 8 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg, width: "100%", maxWidth: layout.content, alignSelf: "center" },
});
