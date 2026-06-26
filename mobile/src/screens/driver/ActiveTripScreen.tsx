import React, { useMemo, useRef, useState } from "react";
import { Image, Linking, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { TripsStackParamList, DriverTabParamList } from "../../navigation/types";
import {
  useTrip,
  useUpdateTripStatus,
  useUpdateStopDocs,
  useTripRoute,
  useUploadPod,
} from "../../hooks/queries";
import { capturePodPhoto } from "../../lib/photo";
import { useTripLocation, TripLocationState } from "../../hooks/useTripLocation";
import { useToast } from "../../components/Toast";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Button } from "../../components/Button";
import { LoadingState, ErrorState } from "../../components/States";
import { PLANT_ORIGIN, regionFor, zoneCoord, haversineKm } from "../../lib/geo";
import { mapsEnabled } from "../../lib/maps";
import { MapPlaceholder } from "../../components/MapPlaceholder";
import { tripDestination, tripDestZone } from "../../lib/trip";
import { formatMoney } from "../../lib/format";
import { TripStop } from "../../types";

type Nav = NativeStackNavigationProp<TripsStackParamList, "ActiveTrip">;
type Rt = RouteProp<TripsStackParamList, "ActiveTrip">;

export function ActiveTripScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const toast = useToast();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch } = useTrip(params.tripId);

  // Phase 5: track this phone's GPS while the trip is active, and fetch the
  // real road path. Both hooks run unconditionally (before the early returns
  // below) to keep hook order stable across renders.
  const tracking = useTripLocation(params.tripId, trip?.status === "in_progress");
  const { data: route } = useTripRoute(params.tripId, Boolean(trip));

  const sheetRef = useRef<BottomSheet>(null);
  // Open taller by default so the current stop's action button is reachable
  // without dragging the sheet up (big-touch: drivers act one-handed).
  const snapPoints = useMemo(() => ["45%", "88%"], []);
  const [error, setError] = useState<string | null>(null);
  const [earned, setEarned] = useState<string | number | null>(null);

  const updateStatus = useUpdateTripStatus();
  const updateDocs = useUpdateStopDocs();
  const uploadPod = useUploadPod();

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const dest = zoneCoord(tripDestZone(trip));
  const region = regionFor(PLANT_ORIGIN, dest);
  const distance = haversineKm(PLANT_ORIGIN, dest);
  // Active (not-yet-delivered) stops float to the top so the stop the driver is
  // working on — and its action button — is the first thing in the sheet.
  const stops = (trip.stops ?? []).slice().sort((a, b) => {
    const ad = a.status === "delivered" ? 1 : 0;
    const bd = b.status === "delivered" ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return a.sequence - b.sequence;
  });

  // Hand off to Google Maps for real turn-by-turn (drivers won't use in-app nav).
  const openInMaps = () => {
    Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&destination=${dest.latitude},${dest.longitude}&travelmode=driving`
    );
  };

  const onArrived = async (stop: TripStop) => {
    setError(null);
    try {
      await updateStatus.mutateAsync({ tripId: trip.id, action: "arrived", stop_id: stop.id });
      toast(t("trip.toastArrived"), "success");
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

  // Camera-first POD capture → compress ≤500KB → upload. The API flips
  // do_uploaded, which (with the K2 ack where applicable) unlocks "Delivered".
  const onCapturePod = async (stop: TripStop) => {
    setError(null);
    try {
      const photo = await capturePodPhoto();
      if (!photo) return; // cancelled or permission denied
      await uploadPod.mutateAsync({ tripId: trip.id, stopId: stop.id, photo });
      toast(t("trip.podUploaded"), "success");
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
      } else {
        toast(t("trip.toastDelivered"), "success");
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <View style={styles.fill}>
      {/* Full-screen map (the hero) — falls back to a placeholder when no
          Google Maps API key is configured, since MapView would crash. */}
      {mapsEnabled ? (
        <MapView style={StyleSheet.absoluteFill} initialRegion={region}>
          <Marker coordinate={PLANT_ORIGIN} title="UWC Batu Kawan" pinColor={colors.blue} />
          <Marker coordinate={dest} title={tripDestination(trip)} pinColor={colors.red} />
          {/* Real road path from Google Directions; straight line until it loads */}
          <Polyline
            coordinates={route?.polyline?.length ? route.polyline : [PLANT_ORIGIN, dest]}
            strokeColor={colors.blue}
            strokeWidth={5}
          />
          {/* Live "you are here" dot from this phone's GPS */}
          {tracking.current ? (
            <Marker coordinate={tracking.current} anchor={{ x: 0.5, y: 0.5 }} flat>
              <View style={styles.liveDotRing}>
                <View style={styles.liveDotCore} />
              </View>
            </Marker>
          ) : null}
        </MapView>
      ) : (
        <MapPlaceholder style={StyleSheet.absoluteFill} />
      )}

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
          {trip.status === "in_progress" ? <TrackingBadge tracking={tracking} /> : null}
        </View>
        {/* Real turn-by-turn handoff to Google Maps */}
        <TouchableOpacity style={styles.navBtn} onPress={openInMaps} activeOpacity={0.85}>
          <Ionicons name="navigate" size={20} color={colors.white} />
          <Text style={styles.navBtnText}>{t("trip.navigate")}</Text>
        </TouchableOpacity>
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
              uploadingPod={uploadPod.isPending}
              onArrived={() => onArrived(stop)}
              onToggleDoc={(f, v) => toggleDoc(stop, f, v)}
              onCapturePod={() => onCapturePod(stop)}
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
                // Reset the Trips stack, then switch to the Home (Dashboard) tab
                // so the button actually lands where its label says.
                navigation.popToTop();
                navigation.getParent<BottomTabNavigationProp<DriverTabParamList>>()?.navigate("Home");
              }}
              style={{ alignSelf: "stretch", marginTop: 20 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Small status chip in the heading card: live / locating / offline+queued.
function TrackingBadge({ tracking }: { tracking: TripLocationState }) {
  const { t } = useTranslation();
  const offline = !tracking.online || tracking.queued > 0;

  let dotColor: string = colors.green;
  let label = t("trip.live");
  if (tracking.status === "denied") {
    dotColor = colors.red;
    label = t("trip.locationOff");
  } else if (offline) {
    dotColor = colors.orange;
    label = t("trip.offlineQueued", { count: tracking.queued });
  } else if (tracking.status !== "tracking" || !tracking.current) {
    dotColor = colors.textFaint;
    label = t("trip.locating");
  }

  return (
    <View style={styles.trackBadge}>
      <View style={[styles.trackDot, { backgroundColor: dotColor }]} />
      <Text style={styles.trackText}>{label}</Text>
    </View>
  );
}

function StopCard({
  stop,
  index,
  busy,
  uploadingPod,
  onArrived,
  onToggleDoc,
  onCapturePod,
  onDelivered,
}: {
  stop: TripStop;
  index: number;
  busy: boolean;
  uploadingPod: boolean;
  onArrived: () => void;
  onToggleDoc: (field: "do_uploaded" | "k2_form_ack", value: boolean) => void;
  onCapturePod: () => void;
  onDelivered: () => void;
}) {
  const { t } = useTranslation();
  const isK2 = stop.consignee?.zone_code === "K2";
  // do_uploaded is now driven by the POD photo upload, not a checkbox.
  const docsComplete = stop.do_uploaded && (!isK2 || stop.k2_form_ack);
  // Translated stop-status label (was a raw, untranslated enum like "ARRIVED").
  const statusLabel: Record<string, string> = {
    pending: t("trip.stopPending"),
    arrived: t("trip.stopArrived"),
    delivered: t("trip.stopDelivered"),
  };

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
          <Text style={styles.stopStatus}>
            {(statusLabel[stop.status] ?? stop.status).toUpperCase()}
          </Text>
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

      {/* arrived → POD photo gate + Delivered button */}
      {stop.status === "arrived" ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.gateHint}>{t("trip.podGateHint")}</Text>

          {/* POD photo: capture (camera-first) or show the uploaded shot */}
          {stop.pod_photo ? (
            <View style={styles.podRow}>
              <Image source={{ uri: stop.pod_photo }} style={styles.podThumb} />
              <View style={{ flex: 1 }}>
                <View style={styles.podDoneRow}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.green} />
                  <Text style={styles.podDoneText}>{t("trip.podUploaded")}</Text>
                </View>
                <TouchableOpacity onPress={onCapturePod} hitSlop={8} disabled={uploadingPod}>
                  <Text style={styles.podRetake}>{t("trip.podRetake")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <Button
              title={t("trip.podCapture")}
              onPress={onCapturePod}
              loading={uploadingPod}
              variant="outline"
              style={{ marginTop: 4 }}
              icon={<Ionicons name="camera" size={18} color={colors.blue} />}
            />
          )}

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
    <TouchableOpacity
      style={styles.checkRow}
      onPress={() => onToggle(!checked)}
      activeOpacity={0.7}
      hitSlop={8}
    >
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Ionicons name="checkmark" size={18} color={colors.white} /> : null}
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

  navBtn: {
    backgroundColor: colors.blue,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 64,
    gap: 2,
  },
  navBtnText: { color: colors.white, fontSize: 12, fontWeight: "700" },

  trackBadge: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  trackDot: { width: 8, height: 8, borderRadius: 4 },
  trackText: { fontSize: 12, fontWeight: "700", color: colors.navy },

  // Live GPS dot on the map (blue core inside a soft ring).
  liveDotRing: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(0,48,135,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  liveDotCore: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.blue,
    borderWidth: 2,
    borderColor: colors.white,
  },

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
  podRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  podThumb: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.bg },
  podDoneRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  podDoneText: { fontSize: 13, fontWeight: "700", color: colors.green },
  podRetake: { fontSize: 13, fontWeight: "700", color: colors.blue, marginTop: 4 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  checkBox: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
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
