import React, { useMemo, useRef, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { TripsStackParamList } from "../../navigation/types";
import { useTrip, useUpdateTripStatus, useUpdateStopDocs } from "../../hooks/queries";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Button } from "../../components/Button";
import { LoadingState, ErrorState } from "../../components/States";
import { PLANT_ORIGIN, regionFor, zoneCoord, haversineKm } from "../../lib/geo";
import { tripDestination, tripDestZone } from "../../lib/trip";
import { formatMoney } from "../../lib/format";
import { TripStop } from "../../types";

type Nav = NativeStackNavigationProp<TripsStackParamList, "ActiveTrip">;
type Rt = RouteProp<TripsStackParamList, "ActiveTrip">;

export function ActiveTripScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch } = useTrip(params.tripId);

  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["32%", "78%"], []);
  const [error, setError] = useState<string | null>(null);
  const [earned, setEarned] = useState<string | number | null>(null);

  const updateStatus = useUpdateTripStatus();
  const updateDocs = useUpdateStopDocs();

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const dest = zoneCoord(tripDestZone(trip));
  const region = regionFor(PLANT_ORIGIN, dest);
  const distance = haversineKm(PLANT_ORIGIN, dest);
  const stops = (trip.stops ?? []).slice().sort((a, b) => a.sequence - b.sequence);

  const onArrived = async (stop: TripStop) => {
    setError(null);
    try {
      await updateStatus.mutateAsync({ tripId: trip.id, action: "arrived", stop_id: stop.id });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const toggleDoc = async (stop: TripStop, field: "do_uploaded" | "k2_form_ack", value: boolean) => {
    setError(null);
    try {
      await updateDocs.mutateAsync({ tripId: trip.id, stopId: stop.id, [field]: value });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const onDelivered = async (stop: TripStop) => {
    setError(null);
    try {
      const updated = await updateStatus.mutateAsync({
        tripId: trip.id,
        action: "delivered",
        stop_id: stop.id,
      });
      if (updated.status === "completed") {
        setEarned(updated.incentive_earned);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <View style={styles.fill}>
      {/* Full-screen map (the hero) */}
      <MapView style={StyleSheet.absoluteFill} initialRegion={region}>
        <Marker coordinate={PLANT_ORIGIN} title="UWC Batu Kawan" pinColor={colors.blue} />
        <Marker coordinate={dest} title={tripDestination(trip)} pinColor={colors.red} />
        <Polyline coordinates={[PLANT_ORIGIN, dest]} strokeColor={colors.blue} strokeWidth={5} />
      </MapView>

      {/* Floating top card */}
      <View style={[styles.topCard, { top: insets.top + 8 }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={22} color={colors.navy} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headingLabel}>{t("trip.headingTo")}</Text>
          <Text style={styles.headingDest}>{tripDestination(trip)}</Text>
          <Text style={styles.headingSub}>
            ≈ {distance} {t("common.km")} · {trip.truck_plate ?? ""}
          </Text>
        </View>
      </View>

      {/* Bottom sheet with the stop list + action buttons */}
      <BottomSheet ref={sheetRef} index={0} snapPoints={snapPoints}>
        <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
          <View style={styles.sheetHandleRow}>
            <Text style={styles.sheetTitle}>{t("trip.stops")}</Text>
            <Text style={styles.sheetTicket}>{trip.ticket_number}</Text>
          </View>

          {stops.map((stop, idx) => (
            <StopCard
              key={stop.id}
              stop={stop}
              index={idx}
              busy={updateStatus.isPending || updateDocs.isPending}
              onArrived={() => onArrived(stop)}
              onToggleDoc={(f, v) => toggleDoc(stop, f, v)}
              onDelivered={() => onDelivered(stop)}
            />
          ))}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </BottomSheetScrollView>
      </BottomSheet>

      {/* Completion modal */}
      <Modal visible={earned !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="checkmark" size={36} color={colors.white} />
            </View>
            <Text style={styles.modalTitle}>{t("trip.completedTitle")}</Text>
            <Text style={styles.modalSub}>{t("trip.incentiveEarned")}</Text>
            <Text style={styles.modalAmount}>{formatMoney(earned)}</Text>
            <Button
              title={t("trip.backToDashboard")}
              onPress={() => {
                setEarned(null);
                navigation.popToTop();
              }}
              style={{ alignSelf: "stretch", marginTop: 20 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function StopCard({
  stop,
  index,
  busy,
  onArrived,
  onToggleDoc,
  onDelivered,
}: {
  stop: TripStop;
  index: number;
  busy: boolean;
  onArrived: () => void;
  onToggleDoc: (field: "do_uploaded" | "k2_form_ack", value: boolean) => void;
  onDelivered: () => void;
}) {
  const { t } = useTranslation();
  const isK2 = stop.consignee?.zone_code === "K2";
  const docsComplete = stop.do_uploaded && (!isK2 || stop.k2_form_ack);

  return (
    <View style={styles.stopCard}>
      <View style={styles.stopHead}>
        <View style={styles.stopSeq}>
          <Text style={styles.stopSeqText}>{index + 1}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.stopName}>{stop.consignee?.company_name ?? t("trip.stop", { n: index + 1 })}</Text>
          <Text style={styles.stopArea}>
            {[stop.consignee?.area, stop.consignee?.state].filter(Boolean).join(", ") || "—"}
          </Text>
        </View>
        {stop.status === "delivered" ? (
          <View style={styles.deliveredPill}>
            <Ionicons name="checkmark-circle" size={16} color={colors.green} />
            <Text style={styles.deliveredText}>{t("trip.markDelivered")}</Text>
          </View>
        ) : (
          <Text style={styles.stopStatus}>{stop.status.toUpperCase()}</Text>
        )}
      </View>

      {/* pending → Arrived button */}
      {stop.status === "pending" ? (
        <Button
          title={t("trip.arrivedAtPickup")}
          onPress={onArrived}
          loading={busy}
          variant="primary"
          style={{ marginTop: 12 }}
          icon={<Ionicons name="location" size={18} color={colors.white} />}
        />
      ) : null}

      {/* arrived → documentation gate + Delivered button */}
      {stop.status === "arrived" ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.gateHint}>{t("trip.docGateHint")}</Text>
          <DocCheckbox
            label={t("trip.doUploaded")}
            checked={stop.do_uploaded}
            onToggle={(v) => onToggleDoc("do_uploaded", v)}
          />
          {isK2 ? (
            <DocCheckbox
              label={t("trip.k2Form")}
              checked={stop.k2_form_ack}
              onToggle={(v) => onToggleDoc("k2_form_ack", v)}
            />
          ) : null}
          <Button
            title={t("trip.markDelivered")}
            onPress={onDelivered}
            loading={busy}
            disabled={!docsComplete}
            variant="accent"
            style={{ marginTop: 8 }}
            icon={<Ionicons name="checkmark" size={18} color={colors.navy} />}
          />
        </View>
      ) : null}
    </View>
  );
}

function DocCheckbox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <TouchableOpacity style={styles.checkRow} onPress={() => onToggle(!checked)} activeOpacity={0.7}>
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Ionicons name="checkmark" size={16} color={colors.white} /> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  topCard: {
    position: "absolute",
    left: 12,
    right: 12,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    ...shadow.floating,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  headingLabel: { fontSize: 11, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  headingDest: { fontSize: 20, fontWeight: "800", color: colors.navy, marginTop: 2 },
  headingSub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },

  sheetContent: { paddingHorizontal: 16, paddingBottom: 40 },
  sheetHandleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.navy },
  sheetTicket: { fontSize: 12, fontWeight: "700", color: colors.blue },

  stopCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.borderLight },
  stopHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  stopSeq: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  stopSeqText: { color: colors.white, fontWeight: "800", fontSize: 13 },
  stopName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  stopArea: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  stopStatus: { fontSize: 10, fontWeight: "800", color: colors.orange },
  deliveredPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  deliveredText: { fontSize: 11, fontWeight: "800", color: colors.green },

  gateHint: { fontSize: 12, color: colors.textMuted, marginBottom: 10, lineHeight: 17 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  checkBox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  checkBoxOn: { backgroundColor: colors.green, borderColor: colors.green },
  checkLabel: { flex: 1, fontSize: 13, color: colors.navy, fontWeight: "600" },

  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginTop: 8 },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 32, alignItems: "center", width: "100%" },
  modalIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.green, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 22, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalSub: { fontSize: 13, color: colors.textMuted },
  modalAmount: { fontSize: 42, fontWeight: "900", color: colors.green, marginTop: 4 },
});
