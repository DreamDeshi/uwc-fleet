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
import { useTrip, useUpdateTripStatus } from "../../hooks/queries";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { StatusBadge } from "../../components/StatusBadge";
import { RouteLine } from "../../components/RouteLine";
import { LiveTripMap } from "../../components/LiveTripMap";
import { LoadingState, ErrorState } from "../../components/States";
import { formatMoney, formatDate, formatTime } from "../../lib/format";
import {
  tripDestination,
  tripDestZone,
  tripConsigneeName,
  cargoSummary,
  totalPallets,
  estimateIncentive,
  firstStop,
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
  const [error, setError] = React.useState<string | null>(null);

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const consignee = firstStop(trip)?.consignee;

  // Show the real incentive once it's finalised (set on completion); before
  // that, show an estimate (destination points × truck rate) marked "Estimated".
  const finalized = trip.incentive_earned !== null && trip.incentive_earned !== undefined;
  const estimate = finalized ? null : estimateIncentive(trip);
  const incentiveValue = finalized
    ? formatMoney(trip.incentive_earned)
    : estimate !== null
      ? formatMoney(estimate)
      : formatMoney(trip.incentive_earned);
  const incentiveSub = !finalized && estimate !== null ? t("trip.estimated") : undefined;

  const onStart = async () => {
    setError(null);
    try {
      await startTrip.mutateAsync({ tripId: trip.id, action: "start" });
      navigation.replace("ActiveTrip", { tripId: trip.id });
    } catch (err) {
      setError(apiErrorMessage(err));
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
          <LiveTripMap tripId={trip.id} destZone={tripDestZone(trip)} live={false} height={190} />
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
            <InfoCard icon="calendar-outline" label={t("booking.pickupDate")} value={formatDate(trip.pickup_datetime)} sub={formatTime(trip.pickup_datetime)} />
            <InfoCard icon="cube-outline" label={t("trip.cargo")} value={`${totalPallets(trip)}`} sub={t("booking.pallet")} />
            <InfoCard icon="cash-outline" label={t("trip.incentive")} value={incentiveValue} sub={incentiveSub} valueColor={colors.green} />
          </View>

          {/* Consignee */}
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.cardLabel}>{t("trip.consignee")}</Text>
            <Text style={styles.consigneeName}>{tripConsigneeName(trip)}</Text>
            {consignee?.contact_person ? (
              <Text style={styles.consigneeSub}>{consignee.contact_person}</Text>
            ) : null}
            {[consignee?.area, consignee?.state].filter(Boolean).length > 0 ? (
              <Text style={styles.consigneeArea}>
                {[consignee?.area, consignee?.state].filter(Boolean).join(", ")}
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
            icon={<Ionicons name="play" size={18} color={colors.white} />}
          />
        ) : trip.status === "in_progress" ? (
          <Button
            title={t("trip.openMap")}
            onPress={() => navigation.navigate("ActiveTrip", { tripId: trip.id })}
            icon={<Ionicons name="navigate" size={18} color={colors.white} />}
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
  body: { padding: 16 },
  chipsRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  ticketChip: { backgroundColor: colors.blue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.sm },
  ticketChipText: { color: colors.white, fontSize: 11, fontWeight: "700" },
  typeChip: { backgroundColor: colors.tintBlue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill },
  typeChipText: { color: colors.blue, fontSize: 11, fontWeight: "700" },
  infoRow: { flexDirection: "row", gap: 10, marginBottom: 12, alignItems: "stretch" },
  infoCard: { flex: 1, minHeight: 104, backgroundColor: colors.white, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 8, alignItems: "center", justifyContent: "flex-start", ...shadow.card },
  infoLabel: { fontSize: 10, color: colors.textFaint, fontWeight: "600", textTransform: "uppercase", marginTop: 6, marginBottom: 4, textAlign: "center" },
  infoValue: { fontSize: 16, fontWeight: "800", color: colors.navy, textAlign: "center" },
  infoSub: { fontSize: 11, color: colors.textFaint, marginTop: 2, textAlign: "center" },
  cardLabel: { fontSize: 11, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  consigneeName: { fontSize: 15, fontWeight: "700", color: colors.navy },
  consigneeSub: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  consigneeArea: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  phoneRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.bg },
  phoneInfo: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  phoneNumber: { fontSize: 14, fontWeight: "700", color: colors.blue },
  callBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.green },
  callBtnText: { color: colors.white, fontSize: 13, fontWeight: "800" },
  smallStrong: { fontSize: 13, fontWeight: "700", color: colors.navy },
  smallMuted: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginTop: 8 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
});
