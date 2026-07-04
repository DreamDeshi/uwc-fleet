import React, { useMemo, useRef, useState } from "react";
import { Image, Linking, Modal, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from "react-native";
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
import { capturePodPhoto, toDurablePhotoUri } from "../../lib/photo";
import { useTripLocation, TripLocationState } from "../../hooks/useTripLocation";
import { useToast } from "../../components/Toast";
import { apiErrorCode, apiErrorMessage, isNetworkError } from "../../services/api";
import { enqueuePodItem, removePodItem, noteDirectPodUpload, findOutboxItem, type PodOutboxItem } from "../../lib/podOutbox";
import { usePodOutboxItems } from "../../hooks/usePodOutbox";
import { colors, radius, shadow } from "../../theme";
import { Button } from "../../components/Button";
import { LoadingState, ErrorState } from "../../components/States";
import { PLANT_ORIGIN, regionFor, zoneCoord, haversineKm } from "../../lib/geo";
import { ActiveTripMap } from "../../components/ActiveTripMap";
import { tripDestination, tripDestZone } from "../../lib/trip";
import { formatMoney, formatDateTime } from "../../lib/format";
import { TripStop } from "../../types";

type Nav = NativeStackNavigationProp<TripsStackParamList, "ActiveTrip">;
type Rt = RouteProp<TripsStackParamList, "ActiveTrip">;

// Error codes that mean the server is ALREADY in (or past) the state the tap
// was trying to reach — the committed-but-lost-response pattern on bad
// signal. These are reconciles, not failures: refetch and let the screen
// catch up to reality instead of leaving a "stuck" button that keeps erroring.
const ARRIVED_ALREADY_CODES = ["INVALID_STATUS"]; // this endpoint's "already marked arrived"
const DELIVERED_ALREADY_CODES = [
  "STOP_ALREADY_DELIVERED",
  "TRIP_ALREADY_FINALIZED",
  // The trip left in_progress — for a delivered tap on this screen that means
  // the lost write was the FINAL stop and the trip completed.
  "TRIP_NOT_ACTIVE",
];

export function ActiveTripScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const toast = useToast();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);

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
  // POD offline outbox: deliveries saved on dead signal live here until the
  // background flush (usePodOutboxFlush in DriverTabs) replays them. The
  // per-stop queued item drives the "waiting for signal" UI below.
  const outbox = usePodOutboxItems();

  // Web double-click can synthesize a second press before React re-renders
  // with isPending=true (the same RN-web double-fire class of bug as the
  // booking form's oncePerTap). The ref flips SYNCHRONOUSLY, so the second
  // tap is swallowed client-side before it fires a duplicate request — the
  // server is idempotent anyway, but the 409 it returns reads as a scary
  // error to a driver.
  const actionInFlight = useRef(false);
  const oncePerAction = async (fn: () => Promise<void>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      await fn();
    } finally {
      actionInFlight.current = false;
    }
  };

  // A "you already did this" reply after a lost response: resync the screen
  // to server truth and tell the driver it's recorded — never an error toast.
  const reconcile = async () => {
    await refetch();
    toast(t("trip.alreadyRecorded"), "success");
  };

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

  const onArrived = (stop: TripStop) =>
    oncePerAction(async () => {
      setError(null);
      try {
        await updateStatus.mutateAsync({ tripId: trip.id, action: "arrived", stop_id: stop.id });
        toast(t("trip.toastArrived"), "success");
      } catch (err) {
        if (ARRIVED_ALREADY_CODES.includes(apiErrorCode(err) ?? "")) {
          await reconcile();
          return;
        }
        // Dead signal: queue the arrival so the POD flow UNLOCKS (the photo +
        // Delivered UI gates on arrived) — the whole stop can now complete
        // offline and replay in order when signal returns.
        if (isNetworkError(err)) {
          try {
            await enqueuePodItem({ tripId: trip.id, stopId: stop.id, markArrived: true });
            toast(t("trip.savedOffline"), "info");
            return;
          } catch {
            // storage full/unavailable — fall through to the normal error
          }
        }
        const msg = apiErrorMessage(err);
        setError(msg);
        // Toast too (same rationale as onCapturePod): the inline error sits in
        // the often-collapsed bottom sheet — on bad signal a silent failure
        // looks like the tap registered when it didn't.
        toast(msg, "error");
      }
    });

  const toggleDoc = async (stop: TripStop, field: "do_uploaded" | "k2_form_ack", value: boolean) => {
    setError(null);
    try {
      await updateDocs.mutateAsync({ tripId: trip.id, stopId: stop.id, [field]: value });
    } catch (err) {
      // Dead signal while TICKING the K2 ack: remember it in the outbox so the
      // background flush sets the flag before confirming delivery. (Unticking
      // offline isn't queued — the flush only ever asserts the ack.)
      if (isNetworkError(err) && field === "k2_form_ack" && value) {
        try {
          await enqueuePodItem({ tripId: trip.id, stopId: stop.id, k2FormAck: true });
          toast(t("trip.savedOffline"), "info");
          return;
        } catch {
          // storage full/unavailable — fall through to the normal error
        }
      }
      const msg = apiErrorMessage(err);
      setError(msg);
      toast(msg, "error");
    }
  };

  // Camera-first POD capture → compress ≤500KB → upload. The API flips
  // do_uploaded, which (with the K2 ack where applicable) unlocks "Delivered".
  const onCapturePod = async (stop: TripStop) => {
    setError(null);
    let captured: { uri: string; name: string; type: string } | null = null;
    try {
      const photo = await capturePodPhoto();
      if (photo === "permission_denied") {
        // Without a POD the Delivered gate never unlocks — the driver must be
        // told the fix is enabling camera access (a dismissed browser prompt
        // counts as denied on the web build). A cancel, by contrast, is a
        // deliberate non-event and shows nothing.
        const msg = t("trip.cameraBlocked");
        setError(msg);
        toast(msg, "error");
        return;
      }
      if (!photo) return; // user cancelled — not an error
      captured = photo;
      await uploadPod.mutateAsync({ tripId: trip.id, stopId: stop.id, photo });
      // If this stop had a queued offline photo, the direct upload supersedes
      // it — don't let the flush re-send a stale shot.
      await noteDirectPodUpload(stop.id);
      toast(t("trip.podUploaded"), "success");
    } catch (err) {
      // Dead signal with the photo ALREADY captured: queue it locally and let
      // the driver carry on — this is a save, not a failure. The uri is made
      // reload-durable first (web blob: URLs die with the page).
      if (captured && isNetworkError(err)) {
        try {
          const durable = await toDurablePhotoUri(captured);
          await enqueuePodItem({ tripId: trip.id, stopId: stop.id, photo: durable });
          toast(t("trip.savedOffline"), "info");
          return;
        } catch {
          // storage full/unavailable — fall through to the normal error
        }
      }
      const msg = apiErrorMessage(err);
      setError(msg);
      // Also surface via the toast overlay — the inline error sits inside the
      // bottom sheet, which is often collapsed, so on web it looked like nothing
      // happened after the photo was picked.
      toast(msg, "error");
    }
  };

  // Queue the Delivered intent locally (photo/K2 already merged on the item if
  // they were captured offline) — the background flush completes the stop.
  const queueDeliveredOffline = async (stop: TripStop): Promise<boolean> => {
    try {
      await enqueuePodItem({ tripId: trip.id, stopId: stop.id, confirmDelivered: true });
      toast(t("trip.savedOffline"), "info");
      return true;
    } catch {
      return false; // storage full/unavailable — caller shows the normal error
    }
  };

  const onDelivered = (stop: TripStop) =>
    oncePerAction(async () => {
      setError(null);
      // The server would reject this delivered confirm outright while the POD
      // photo is still queued on the phone (DOCUMENTATION_INCOMPLETE — it has
      // no photo yet), so don't even try: record the intent and let the flush
      // run photo → ack → delivered in order once signal returns.
      const queued = findOutboxItem(outbox, stop.id);
      if (queued && (queued.photo || (queued.k2FormAck && !queued.k2Acked))) {
        if (await queueDeliveredOffline(stop)) return;
      }
      try {
        const updated = await updateStatus.mutateAsync({
          tripId: trip.id,
          action: "delivered",
          stop_id: stop.id,
        });
        // Delivered through the normal online path — clear any leftover
        // queued intent for this stop so the flush has nothing to replay.
        await removePodItem(stop.id);
        if (updated.status === "completed") {
          setEarned(updated.incentive_earned);
        } else {
          toast(t("trip.toastDelivered"), "success");
        }
      } catch (err) {
        if (DELIVERED_ALREADY_CODES.includes(apiErrorCode(err) ?? "")) {
          await removePodItem(stop.id);
          await reconcile();
          return;
        }
        // Dead signal on the confirm itself: save the tap instead of losing it.
        if (isNetworkError(err) && (await queueDeliveredOffline(stop))) return;
        const msg = apiErrorMessage(err);
        setError(msg);
        // Delivered gates the driver's pay — a silently-lost tap here means an
        // unfinalized incentive, so the failure must be impossible to miss.
        toast(msg, "error");
      }
    });

  return (
    <View style={styles.fill}>
      {/* Full-screen map (the hero). Native renders react-native-maps; the web
          build swaps in a placeholder via ActiveTripMap.web.tsx. */}
      <ActiveTripMap
        region={region}
        dest={dest}
        destLabel={tripDestination(trip)}
        polyline={route?.polyline}
        current={tracking.current}
      />

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
        <BottomSheetScrollView
          contentContainerStyle={styles.sheetContent}
          // Manual resync for the lost-response case the reconcile codes miss
          // (e.g. the driver backgrounds the tab mid-write and comes back).
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        >
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
              queued={findOutboxItem(outbox, stop.id)}
              onArrived={() => onArrived(stop)}
              onToggleDoc={(f, v) => toggleDoc(stop, f, v)}
              onCapturePod={() => onCapturePod(stop)}
              onDelivered={() => onDelivered(stop)}
            />
          ))}

          {/* Requestor-uploaded documents (DO / invoice) — reference during
              delivery. Tapping opens the Cloudinary file in the browser. */}
          {trip.documents && trip.documents.length > 0 ? (
            <View style={styles.docSection}>
              <Text style={styles.docSectionTitle}>{t("trip.documents")}</Text>
              {trip.documents.map((doc) => (
                <TouchableOpacity
                  key={doc.id}
                  style={styles.docRow}
                  onPress={() => Linking.openURL(doc.file_url)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="document-text-outline" size={20} color={colors.blue} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docName}>
                      {t(
                        doc.type === "do_photo"
                          ? "bookingDetail.docTypeDO"
                          : doc.type === "k2_form"
                            ? "bookingDetail.docTypeK2"
                            : "bookingDetail.docTypeOther"
                      )}
                    </Text>
                    <Text style={styles.docDate}>{formatDateTime(doc.uploaded_at)}</Text>
                  </View>
                  <Ionicons name="open-outline" size={18} color={colors.blue} />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

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
  queued,
  onArrived,
  onToggleDoc,
  onCapturePod,
  onDelivered,
}: {
  stop: TripStop;
  index: number;
  busy: boolean;
  uploadingPod: boolean;
  queued?: PodOutboxItem;
  onArrived: () => void;
  onToggleDoc: (field: "do_uploaded" | "k2_form_ack", value: boolean) => void;
  onCapturePod: () => void;
  onDelivered: () => void;
}) {
  const { t } = useTranslation();
  const isK2 = stop.consignee?.zone_code === "K2";
  // Offline-queued pieces count toward the gate: the arrival/photo/ack are
  // safely on the phone and the flush replays them (in order) before the
  // delivered confirm, so the driver isn't blocked by dead signal.
  const queuedPhoto = queued?.photo != null || queued?.photoUploaded === true;
  const queuedAck = queued?.k2FormAck === true;
  // Arrived (server) or arrived-saved-on-phone — unlocks the POD section.
  const arrivedLocal =
    stop.status === "arrived" || (stop.status === "pending" && queued?.markArrived === true);
  // Delivered already queued → the stop is done as far as the driver is
  // concerned; show the waiting-for-signal state instead of buttons.
  const deliveryQueued = queued?.confirmDelivered === true && stop.status !== "delivered";
  // do_uploaded is now driven by the POD photo upload, not a checkbox.
  const docsComplete = (stop.do_uploaded || queuedPhoto) && (!isK2 || stop.k2_form_ack || queuedAck);
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
        ) : deliveryQueued ? (
          <View style={styles.queuedPill}>
            <Ionicons name="cloud-upload-outline" size={16} color={colors.orange} />
            <Text style={styles.queuedText}>{t("trip.waitingSignal")}</Text>
          </View>
        ) : (
          <Text style={styles.stopStatus}>
            {(statusLabel[stop.status] ?? stop.status).toUpperCase()}
          </Text>
        )}
      </View>

      {/* Delivered is saved on this phone — nothing left for the driver to do
          at this stop; the outbox completes it when signal returns. */}
      {deliveryQueued ? (
        <Text style={styles.queuedHint}>{t("trip.savedOffline")}</Text>
      ) : null}

      {/* pending → Arrived button (hidden once arrival is saved on-phone) */}
      {stop.status === "pending" && !arrivedLocal && !deliveryQueued ? (
        <Button
          title={t("trip.arrivedAtPickup")}
          onPress={onArrived}
          loading={busy}
          variant="primary"
          style={{ marginTop: 12 }}
          icon={<Ionicons name="location" size={18} color={colors.white} />}
        />
      ) : null}

      {/* arrived (server or saved-on-phone) → POD photo gate + Delivered.
          Hidden once the delivery itself is queued — nothing left to do. */}
      {arrivedLocal && !deliveryQueued ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.gateHint}>{t("trip.podGateHint")}</Text>

          {/* POD photo: capture (camera-first), the uploaded shot, or the
              offline-queued shot waiting for signal */}
          {stop.pod_photo || queued?.photo ? (
            <View style={styles.podRow}>
              <Image
                source={{ uri: stop.pod_photo ?? queued!.photo!.uri }}
                style={styles.podThumb}
              />
              <View style={{ flex: 1 }}>
                <View style={styles.podDoneRow}>
                  <Ionicons
                    name={stop.pod_photo ? "checkmark-circle" : "cloud-upload-outline"}
                    size={16}
                    color={stop.pod_photo ? colors.green : colors.orange}
                  />
                  <Text style={stop.pod_photo ? styles.podDoneText : styles.podQueuedText}>
                    {stop.pod_photo ? t("trip.podUploaded") : t("trip.podQueued")}
                  </Text>
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
              checked={stop.k2_form_ack || queuedAck}
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
  // Offline-outbox states: saved on this phone, waiting for signal.
  queuedPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  queuedText: { fontSize: 11, fontWeight: "800", color: colors.orange },
  queuedHint: { fontSize: 12.5, color: colors.orange, marginTop: 10, lineHeight: 17 },
  podQueuedText: { fontSize: 13, fontWeight: "700", color: colors.orange },

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

  docSection: { marginTop: 4, marginBottom: 8 },
  docSectionTitle: { fontSize: 13, fontWeight: "800", color: colors.navy, marginBottom: 10 },
  docRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.white, borderRadius: radius.md, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.borderLight },
  docName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  docDate: { fontSize: 12, color: colors.textFaint, marginTop: 2 },

  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginTop: 8 },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 32, alignItems: "center", width: "100%" },
  modalIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.green, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 22, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalSub: { fontSize: 13, color: colors.textMuted },
  modalAmount: { fontSize: 42, fontWeight: "900", color: colors.green, marginTop: 4 },
});
