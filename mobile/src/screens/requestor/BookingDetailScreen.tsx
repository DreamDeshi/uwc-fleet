import React, { useState } from "react";
import { Linking, Modal, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "../../navigation/types";
import { useTrip, useCancelTrip, useTripLatestLocation } from "../../hooks/queries";
import { useToast } from "../../components/Toast";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Header } from "../../components/Header";
import { RouteLine } from "../../components/RouteLine";
import { LiveTripMap } from "../../components/LiveTripMap";
import { LoadingState, ErrorState } from "../../components/States";
import { tripDestination, tripConsigneeName, cargoSummary, tripDestZone, ORIGIN_LABEL } from "../../lib/trip";
import { formatDateTime, initials as nameInitials } from "../../lib/format";
import { TripStatus } from "../../types";

type Nav = NativeStackNavigationProp<RequestorStackParamList, "BookingDetail">;
type Rt = RouteProp<RequestorStackParamList, "BookingDetail">;

const ORDER: Record<TripStatus, number> = {
  pending: 0,
  approved: 1,
  rejected: -1,
  assigned: 2,
  in_progress: 3,
  completed: 4,
  cancelled: -1,
};

export function BookingDetailScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);
  const cancelTrip = useCancelTrip();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the truck's latest position while the trip is in transit. The map
  // below reads the same query (shared by key), so this is a single request.
  const inTransit = trip?.status === "in_progress";
  const { data: livePos } = useTripLatestLocation(params.tripId, Boolean(inTransit));

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const banner = bannerFor(trip.status);
  const order = ORDER[trip.status];
  const isCancelled = trip.status === "cancelled" || trip.status === "rejected";
  const canCancel = trip.status === "pending" || trip.status === "approved";

  const timeline = isCancelled
    ? [
        { label: t("bookingDetail.tlSubmitted"), done: true },
        { label: t("bookingDetail.tlCancelled"), cancelled: true },
      ]
    : [
        { label: t("bookingDetail.tlSubmitted"), done: true },
        { label: t("bookingDetail.tlReview"), done: order >= 1 },
        { label: t("bookingDetail.tlAssigned"), done: order >= 2 },
        { label: t("bookingDetail.tlInTransit"), done: order >= 3 },
        { label: t("bookingDetail.tlDelivered"), done: order >= 4 },
      ];
  const activeIndex = timeline.findIndex((s) => !s.done && !("cancelled" in s && s.cancelled));

  const onCancel = async () => {
    setError(null);
    try {
      await cancelTrip.mutateAsync(trip.id);
      setConfirm(false);
      toast(t("bookingDetail.cancelledToast"), "success");
    } catch (e) {
      setError(apiErrorMessage(e));
      setConfirm(false);
    }
  };

  return (
    <View style={styles.fill}>
      <Header title={t("bookingDetail.title")} onBack={() => navigation.goBack()} />

      {/* Status banner */}
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Ionicons name={banner.icon} size={18} color={banner.fg} />
        <Text style={[styles.bannerText, { color: banner.fg }]}>{banner.text(t)}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Pending notice */}
        {trip.status === "pending" ? (
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={18} color="#d97706" />
            <Text style={styles.noticeText}>{t("bookingDetail.pendingNotice")}</Text>
          </View>
        ) : null}

        {/* Assigned driver */}
        {trip.driver ? (
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.cardLabel}>{t("bookingDetail.assignedDriver")}</Text>
            <View style={styles.driverRow}>
              <View style={styles.driverAvatar}>
                <Text style={styles.driverAvatarText}>{nameInitials(trip.driver.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.driverName}>{trip.driver.name}</Text>
                <Text style={styles.driverSub}>{trip.truck_plate} {trip.truck?.type ? `(${trip.truck.type})` : ""}</Text>
                {trip.driver.phone ? <Text style={styles.driverPhone}>📞 {trip.driver.phone}</Text> : null}
              </View>
              {trip.driver.phone ? (
                <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${trip.driver!.phone}`)}>
                  <Ionicons name="call" size={20} color={colors.white} />
                </TouchableOpacity>
              ) : null}
            </View>
          </Card>
        ) : null}

        {/* Live tracking — only while the truck is in transit */}
        {trip.status === "in_progress" ? (
          <Card style={{ marginBottom: 12 }}>
            <View style={styles.detailHead}>
              <Text style={styles.cardLabel}>{t("bookingDetail.liveLocation")}</Text>
              <LiveStatus pos={livePos} />
            </View>
            <View style={{ marginTop: 12 }}>
              <LiveTripMap tripId={trip.id} destZone={tripDestZone(trip)} live height={200} />
            </View>
          </Card>
        ) : null}

        {/* Trip details */}
        <Card style={{ marginBottom: 12 }}>
          <View style={styles.detailHead}>
            <Text style={styles.cardLabel}>{t("bookingDetail.tripDetails")}</Text>
            <View style={styles.ticketChip}>
              <Text style={styles.ticketChipText}>{trip.ticket_number}</Text>
            </View>
          </View>
          {trip.route_type ? (
            <View style={styles.typeChip}>
              <Text style={styles.typeChipText}>{trip.route_type.name}</Text>
            </View>
          ) : null}
          <View style={{ marginTop: 14 }}>
            <RouteLine from={ORIGIN_LABEL} to={tripConsigneeName(trip)} />
          </View>
          <View style={styles.detailGrid}>
            <Detail k={t("bookingDetail.dateTime")} v={formatDateTime(trip.pickup_datetime)} />
            <Detail k={t("bookingDetail.cargo")} v={cargoSummary(trip)} />
            <Detail k={t("bookingDetail.consignee")} v={tripDestination(trip)} />
          </View>
        </Card>

        {/* Timeline */}
        <Card>
          <Text style={[styles.cardLabel, { marginBottom: 16 }]}>{t("bookingDetail.timeline")}</Text>
          {timeline.map((s: any, i: number) => {
            const active = i === activeIndex;
            const color = s.cancelled ? colors.red : s.done ? colors.green : active ? colors.blue : "#c0cbdf";
            return (
              <View key={i} style={styles.tlRow}>
                <View style={styles.tlRail}>
                  <View style={[styles.tlDot, { backgroundColor: color }]}>
                    {s.done ? (
                      <Ionicons name="checkmark" size={13} color={colors.white} />
                    ) : s.cancelled ? (
                      <Ionicons name="close" size={13} color={colors.white} />
                    ) : active ? (
                      <View style={styles.tlInner} />
                    ) : null}
                  </View>
                  {i < timeline.length - 1 ? (
                    <View style={[styles.tlLine, { backgroundColor: s.done ? colors.green : "#e8edf5" }]} />
                  ) : null}
                </View>
                <Text style={[styles.tlLabel, { color: s.done ? colors.green : s.cancelled ? colors.red : active ? colors.blue : colors.textFaint }]}>
                  {s.label}
                </Text>
              </View>
            );
          })}
        </Card>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* Cancel */}
      {canCancel ? (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <Button
            title={t("bookingDetail.cancelRequest")}
            variant="outline"
            onPress={() => setConfirm(true)}
            style={{ borderColor: colors.red }}
            icon={<Ionicons name="close-circle-outline" size={18} color={colors.blue} />}
          />
        </View>
      ) : null}

      <Modal visible={confirm} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="alert" size={28} color={colors.red} />
            </View>
            <Text style={styles.modalTitle}>{t("bookingDetail.cancelConfirmTitle")}</Text>
            <Text style={styles.modalBody}>{t("bookingDetail.cancelConfirmBody")}</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 20 }}>
              <Button title={t("bookingDetail.keepIt")} variant="outline" onPress={() => setConfirm(false)} style={{ flex: 1 }} />
              <Button title={t("bookingDetail.yesCancel")} variant="danger" onPress={onCancel} loading={cancelTrip.isPending} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Small live/stale/waiting chip for the tracking card header.
function LiveStatus({ pos }: { pos?: { stale: boolean } | null }) {
  const { t } = useTranslation();
  let color: string = colors.textFaint;
  let label = t("bookingDetail.locWaiting");
  if (pos) {
    color = pos.stale ? colors.orange : colors.green;
    label = pos.stale ? t("bookingDetail.locStale") : t("bookingDetail.locLive");
  }
  return (
    <View style={styles.liveStatus}>
      <View style={[styles.liveStatusDot, { backgroundColor: color }]} />
      <Text style={[styles.liveStatusText, { color }]}>{label}</Text>
    </View>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.detailCell}>
      <Text style={styles.detailKey}>{k}</Text>
      <Text style={styles.detailVal}>{v}</Text>
    </View>
  );
}

function bannerFor(status: TripStatus): {
  bg: string;
  fg: string;
  icon: keyof typeof Ionicons.glyphMap;
  text: (t: (k: string) => string) => string;
} {
  switch (status) {
    case "pending":
    case "approved":
      return { bg: colors.yellow, fg: colors.navy, icon: "time-outline", text: (t) => t("bookingDetail.bannerPending") };
    case "assigned":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-circle", text: (t) => t("bookingDetail.bannerAccepted") };
    case "in_progress":
      return { bg: colors.blue, fg: colors.white, icon: "navigate", text: (t) => t("bookingDetail.bannerInProgress") };
    case "completed":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-done", text: (t) => t("bookingDetail.bannerCompleted") };
    default:
      return { bg: colors.red, fg: colors.white, icon: "close-circle", text: (t) => t("bookingDetail.bannerCancelled") };
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  banner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 14 },
  bannerText: { fontSize: 14, fontWeight: "700" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintYellow, borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#FFE082" },
  noticeText: { flex: 1, fontSize: 13, fontWeight: "600", color: "#92400e" },
  cardLabel: { fontSize: 12, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  driverRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  driverAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.yellow, marginRight: 12 },
  driverAvatarText: { color: colors.yellow, fontSize: 16, fontWeight: "800" },
  driverName: { fontSize: 15, fontWeight: "700", color: colors.navy },
  driverSub: { fontSize: 13, color: colors.textMuted, marginTop: 3 },
  driverPhone: { fontSize: 13, color: colors.blue, marginTop: 3, fontWeight: "600" },
  callBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" },
  detailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  liveStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveStatusDot: { width: 8, height: 8, borderRadius: 4 },
  liveStatusText: { fontSize: 12, fontWeight: "700" },
  ticketChip: { backgroundColor: colors.blue, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  ticketChipText: { color: colors.white, fontSize: 12, fontWeight: "700" },
  typeChip: { alignSelf: "flex-start", backgroundColor: colors.tintBlue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill, marginTop: 12 },
  typeChipText: { color: colors.blue, fontSize: 12, fontWeight: "700" },
  detailGrid: { marginTop: 14, gap: 12 },
  detailCell: { borderTopWidth: 1, borderTopColor: colors.bg, paddingTop: 10 },
  detailKey: { fontSize: 12, color: colors.textFaint, fontWeight: "600", marginBottom: 4 },
  detailVal: { fontSize: 14, fontWeight: "700", color: colors.navy },
  tlRow: { flexDirection: "row", gap: 14 },
  tlRail: { alignItems: "center" },
  tlDot: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  tlInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.white },
  tlLine: { width: 2, height: 26 },
  tlLabel: { fontSize: 14, fontWeight: "700", paddingTop: 4 },
  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginTop: 12 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 28, alignItems: "center", width: "100%" },
  modalIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fef2f2", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalBody: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
});
