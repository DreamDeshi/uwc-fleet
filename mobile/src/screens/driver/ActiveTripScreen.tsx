// Driver active trip — rebuilt to the agreed design
// (`design/active-trip/Driver Active Trip - Final Flow.dc.html`, screens 1–5
// plus the K2 / offline / skipped-ahead states). Exact px + hex values are
// read from that file, not guessed.
//
// Layout (top → bottom), replacing the old full-screen map + bottom sheet:
//   1. 196px map band (back button, tracking badge)
//   2. progress header + SEGMENTED rail — one flex segment per stop, so it
//      reads the same at 2 stops or 12
//   3. unfinished-stop banner (a POD uploaded but Delivered never tapped)
//   4. scroll body: current-stop card · exception card · upcoming-stops strip
//   5. pinned footer: exactly ONE primary action, above the thumb
//
// EVERY handler below (arrival, POD, K2, delivered, offline outbox, GPS
// consent, reconcile-on-lost-response) is carried over unchanged — this is a
// presentation rebuild. No money, dispatch or API code is touched. The one
// behavioural addition is the POD REVIEW step: capture no longer uploads
// straight away, it opens PodReviewModal and the upload runs on "Use photo".
import React, { useRef, useState } from "react";
import { Linking, Modal, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
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
  useUploadK2,
} from "../../hooks/queries";
import { capturePodPhoto, toDurablePhotoUri, type PickedPhoto } from "../../lib/photo";
import { useTripLocation, TripLocationState } from "../../hooks/useTripLocation";
import { useBackgroundTracking } from "../../hooks/useBackgroundTracking";
import { stopBackgroundTracking } from "../../lib/backgroundLocation";
import { getGpsConsent, setGpsConsent, type GpsConsent } from "../../lib/gpsConsent";
import { useToast } from "../../components/Toast";
import { apiErrorCode, apiErrorMessage, isNetworkError } from "../../services/api";
import { enqueuePodItem, removePodItem, noteDirectPodUpload, findOutboxItem } from "../../lib/podOutbox";
import { usePodOutboxItems } from "../../hooks/usePodOutbox";
import { WebRefreshButton } from "../../components/WebRefreshButton";
import { colors, layout, radius, shadow, type as typeScale } from "../../theme";
import { Button } from "../../components/Button";
import { PodReviewModal } from "../../components/PodReviewModal";
import { footerStage, waitingForDelivered, requiresCustomsDoc, type StageFlags } from "../../lib/activeTripStage";
import { LoadingState, ErrorState } from "../../components/States";
import { PLANT_ORIGIN, regionFor, consigneeDestination, haversineKm } from "../../lib/geo";
import { ActiveTripMap } from "../../components/ActiveTripMap";
import { tripDestination, tripDestZone, consigneeAddress } from "../../lib/trip";
import { formatMoney, formatDateTime, formatTime } from "../../lib/format";
import { exceptionsEnabled } from "../../lib/featureFlags";
import { ReportExceptionSheet } from "../../components/ReportExceptionSheet";
import { ExceptionStatusCard } from "../../components/ExceptionStatusCard";
import { useExceptionOutboxFlush } from "../../hooks/useExceptionOutbox";
import { TripStop } from "../../types";
import { outstandingStops } from "../../lib/stopSettled";

type Nav = NativeStackNavigationProp<TripsStackParamList, "ActiveTrip">;
type Rt = RouteProp<TripsStackParamList, "ActiveTrip">;

// The stop the driver is AT reads in-progress VIOLET — the same hue the
// dispatcher board uses (theme.ts maps in_progress → violet, 7 Jul 2026
// ruling). Owner ruling 29 Jul 2026: the shared status hues are deliberate, so
// one trip reads the same colour on the driver's phone and on the admin board.
// This drives the "NOW · STOP n OF m" marker, the rail's current segment and
// the unfinished-stop banner; a stop that is merely NEXT / HEADING TO (not yet
// arrived at) stays corporate blue.
//
// Rest of the palette unchanged: green delivered, grey upcoming, orange
// offline-only, yellow only for Delivered.
const CURRENT_STOP_HUE = colors.violet;
const CURRENT_STOP_TINT = colors.tintViolet;

// Upcoming-stop strip geometry (design): 150px cards, 10px gutters, 16px page
// padding. Kept as constants because the styles AND the "is it scrollable?"
// test both need them, and they must never drift apart.
const STRIP_CARD_W = 150;
const STRIP_GAP = 10;
const STRIP_PAD = 16;

// Amber for the completion screen's PENDING APPROVAL chip — dark enough for
// AA contrast on tintYellow. A pending incentive must never read as paid, so
// the figure beside it is navy, never green.
const PENDING_AMBER_TEXT = "#8a6d00";

// Darker green than colors.green for AA-contrast text on the tintGreen POD
// line (same hue the theme already uses for actionShadow.green).
const POD_GREEN_TEXT = "#2A7F24";
const POD_GREEN_BORDER = "#b7dcb9";

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

// Zone tag shading on the upcoming-stop cards, by STATE (design rule):
// Penang pale, Kedah solid blue, Perak navy. The current-stop card's own tag
// is deliberately flat (fieldBg/navy) in every zone.
function zoneTagColors(zone?: string | null): { bg: string; fg: string } {
  if (zone === "P1" || zone === "P2" || zone === "P3") return { bg: colors.tintBlue, fg: colors.blue };
  if (zone === "K1" || zone === "K2") return { bg: colors.blue, fg: colors.white };
  return { bg: colors.navy, fg: colors.white }; // A1/A2 (Perak), KL, anything new
}

export function ActiveTripScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const toast = useToast();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);
  // Failed-delivery / exception workflow (feature-gated). Flush the offline
  // report outbox while the driver is on the active-trip surface.
  useExceptionOutboxFlush();
  const [showReport, setShowReport] = useState(false);
  // The stop the driver CHOSE to head to next ("Go here" on a strip card).
  // Stop order is the driver's call (Mr. Teh, 28 Jul 2026: "he can choose his
  // own stop, the order in booking is just for reference only").
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  // The captured-but-not-yet-uploaded POD awaiting review (design screen 3).
  const [review, setReview] = useState<{ photo: PickedPhoto; stop: TripStop } | null>(null);
  // When THIS session uploaded each stop's POD, so the green line can read
  // "POD uploaded · 9:47 AM" the instant it happens.
  //
  // The server now persists the real time (TripStop.pod_uploaded_at, IM6), and
  // that is authoritative — this map only covers the window between the upload
  // resolving and the trip refetch landing, so the line does not flicker from
  // timed to untimed and back. A POD with no server time is genuinely undated
  // (it predates the column) and falls back to the untimed string rather than
  // inventing one.
  const [podTimes, setPodTimes] = useState<Record<string, string>>({});
  const stripRef = useRef<ScrollView>(null);
  const stripOffset = useRef(0);
  // The peek IS the scroll affordance — but only when there is something to
  // scroll to. On a wide shell (or a short run) every card fits, so the fade
  // and the arrow puck must not appear and promise movement that can't happen.
  // Width is computed from the design constants below rather than
  // onContentSizeChange, which react-native-web does not report reliably for a
  // horizontal ScrollView (it left the puck showing on the desktop shell).
  const [stripViewport, setStripViewport] = useState(0);

  // GPS consent (per device): the driver must agree to the active-trip-only
  // explainer before we request the OS location permission.
  const [gpsConsent, setGpsConsentState] = useState<GpsConsent | null>(null);
  const [consentLoaded, setConsentLoaded] = useState(false);
  const [showGpsConsent, setShowGpsConsent] = useState(false);
  const [gpsRetry, setGpsRetry] = useState(0);
  const gpsConsented = gpsConsent === "accepted";

  React.useEffect(() => {
    let alive = true;
    getGpsConsent().then((c) => {
      if (alive) {
        setGpsConsentState(c);
        setConsentLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // First time (never decided) a trip is active on this device, show the
  // explainer. A driver who declined isn't nagged — they re-enable from the badge.
  React.useEffect(() => {
    if (consentLoaded && trip?.status === "in_progress" && gpsConsent === null) {
      setShowGpsConsent(true);
    }
  }, [consentLoaded, trip?.status, gpsConsent]);

  const acceptGps = async () => {
    await setGpsConsent("accepted");
    setGpsConsentState("accepted");
    setGpsRetry((n) => n + 1); // re-request even if a prior OS denial is cached
    setShowGpsConsent(false);
  };
  const declineGps = async () => {
    await setGpsConsent("declined");
    setGpsConsentState("declined");
    setShowGpsConsent(false);
  };

  // Track this phone's GPS while the trip is active AND consented, and fetch
  // the real road path. All hooks run unconditionally (before the early
  // returns below) to keep hook order stable across renders.
  //
  // Background tracking (OS-driven, survives the app being closed/locked) owns
  // capture whenever "Allow all the time" is granted; the foreground hook then
  // stands down its own capture (bg.backgroundActive) and just drives the UI.
  const bg = useBackgroundTracking(
    params.tripId,
    trip?.status === "in_progress",
    gpsConsented,
    gpsRetry
  );
  const tracking = useTripLocation(
    params.tripId,
    trip?.status === "in_progress",
    gpsConsented,
    gpsRetry,
    bg.backgroundActive
  );
  const { data: route } = useTripRoute(params.tripId, Boolean(trip));

  const [error, setError] = useState<string | null>(null);
  const [earned, setEarned] = useState<string | number | null>(null);

  const updateStatus = useUpdateTripStatus();
  const updateDocs = useUpdateStopDocs();
  const uploadPod = useUploadPod();
  const uploadK2 = useUploadK2();
  // POD offline outbox: deliveries saved on dead signal live here until the
  // background flush (usePodOutboxFlush in DriverTabs) replays them.
  const outbox = usePodOutboxItems();

  // Web double-click can synthesize a second press before React re-renders
  // with isPending=true (the RN-web double-fire class of bug). The ref flips
  // SYNCHRONOUSLY, so the second tap is swallowed client-side.
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

  // ── Derived stop model ──────────────────────────────────────────────────
  // The rail and the strip both read the BOOKING order; only the target stop
  // is driver-chosen.
  const bySeq = [...(trip.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
  const deliveredStops = bySeq.filter((s) => s.status === "delivered");
  // OUTSTANDING, not merely not-delivered: a stop the admin verified and closed
  // with "Do not return" (R3 Q11(a)) is settled and paid, so offering the driver
  // a POD button for it would invite him to deliver work the office already
  // closed. lib/stopSettled mirrors the server rule.
  const open = outstandingStops(bySeq);
  const focused = open.find((s) => s.id === focusStopId);
  const activeStop = focused ?? open[0] ?? bySeq[0];
  const upcoming = open.filter((s) => s.id !== activeStop?.id);
  const multiStop = bySeq.length > 1;

  const queuedFor = (s: TripStop) => findOutboxItem(outbox, s.id);
  const stageFlags = (s: TripStop): StageFlags => {
    const q = queuedFor(s);
    return {
      isK2: requiresCustomsDoc(s.consignee?.zone_code, s.consignee?.area),
      arrivedQueued: q?.markArrived === true,
      podQueued: q?.photo != null || q?.photoUploaded === true,
      deliveryQueued: q?.confirmDelivered === true && s.status !== "delivered",
    };
  };
  const stage = activeStop ? footerStage(activeStop, stageFlags(activeStop)) : null;
  const activeQueued = activeStop ? queuedFor(activeStop) : undefined;
  const podDoneHere = Boolean(
    activeStop && (activeStop.pod_photo || activeQueued?.photo || activeQueued?.photoUploaded)
  );
  const podQueuedHere = Boolean(!activeStop?.pod_photo && (activeQueued?.photo || activeQueued?.photoUploaded));

  // Q1 ruling (29 Jul): re-pointing is allowed, but a stop whose POD is up and
  // whose Delivered was never tapped follows the driver in a banner.
  const unfinished = bySeq.filter(
    (s) => s.id !== activeStop?.id && s.status !== "delivered" && waitingForDelivered(s, stageFlags(s))
  );

  const destination = consigneeDestination(
    activeStop?.consignee ?? { zone_code: tripDestZone(trip) }
  );
  const dest = destination.coord;
  const region = regionFor(PLANT_ORIGIN, dest);
  const kmOrigin = tracking.current ?? PLANT_ORIGIN;

  // Hand off to Google Maps for real turn-by-turn (drivers won't use in-app
  // nav). With a geocoded consignee this is the building; without one it is
  // still the zone centroid, and the card says so.
  const openMapsFor = (s?: TripStop) => {
    const c = consigneeDestination(s?.consignee ?? { zone_code: tripDestZone(trip) }).coord;
    Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&destination=${c.latitude},${c.longitude}&travelmode=driving`
    );
  };
  const callConsignee = (s?: TripStop) => {
    if (s?.consignee?.phone) Linking.openURL(`tel:${s.consignee.phone}`);
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
        // Dead signal: queue the arrival so the POD flow UNLOCKS — the whole
        // stop can now complete offline and replay in order.
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
        toast(msg, "error");
      }
    });

  const toggleDoc = async (stop: TripStop, field: "do_uploaded" | "k2_form_ack", value: boolean) => {
    setError(null);
    try {
      await updateDocs.mutateAsync({ tripId: trip.id, stopId: stop.id, [field]: value });
    } catch (err) {
      // Dead signal while asserting the K2 ack: remember it in the outbox so
      // the background flush sets the flag before confirming delivery.
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

  // K2 (Borang K2) document upload for a K2-zone stop (Q6). The delivery gate
  // requires the uploaded document, not a tick. Online-only: on a dead signal
  // the driver is told to reconnect (K2 zones have usable coverage).
  const onCaptureK2 = (stop: TripStop) =>
    oncePerAction(async () => {
      setError(null);
      try {
        const photo = await capturePodPhoto();
        if (photo === "permission_denied") { const m = t("trip.cameraBlocked"); setError(m); toast(m, "error"); return; }
        if (!photo) return;
        await uploadK2.mutateAsync({ tripId: trip.id, stopId: stop.id, photo });
        toast(t("trip.k2Uploaded"), "success");
      } catch (err) {
        if (apiErrorCode(err) === "POD_LOCKED") { await reconcile(); return; }
        if (isNetworkError(err)) { toast(t("trip.k2NeedsConnection"), "error"); return; }
        const msg = apiErrorMessage(err); setError(msg); toast(msg, "error");
      }
    });

  // POD step 1 — capture only. The upload no longer fires here: the photo goes
  // to the review screen, and "Use photo" runs confirmPod() below. A cancel is
  // a deliberate non-event (nothing captured, nothing uploaded).
  const openPodCamera = (stop: TripStop) =>
    oncePerAction(async () => {
      setError(null);
      try {
        const photo = await capturePodPhoto();
        if (photo === "permission_denied") {
          // Without a POD the Delivered gate never unlocks — the driver must
          // be told the fix is enabling camera access (NATIVE only).
          const msg = t("trip.cameraBlocked");
          setError(msg);
          toast(msg, "error");
          return;
        }
        if (!photo) return; // cancelled
        setReview({ photo, stop });
      } catch (err) {
        const msg = apiErrorMessage(err);
        setError(msg);
        toast(msg, "error");
      }
    });

  // POD step 2 — the reviewed photo is uploaded. This is the ORIGINAL upload
  // path (including the offline-outbox fallback), moved behind "Use photo".
  const confirmPod = () =>
    oncePerAction(async () => {
      if (!review) return;
      const { photo, stop } = review;
      setError(null);
      try {
        await uploadPod.mutateAsync({ tripId: trip.id, stopId: stop.id, photo });
        // A direct upload supersedes any queued offline shot for this stop.
        await noteDirectPodUpload(stop.id);
        setPodTimes((m) => ({ ...m, [stop.id]: new Date().toISOString() }));
        setReview(null);
        toast(t("trip.podUploaded"), "success");
      } catch (err) {
        // The trip finalized out from under us: POD is locked. Resync rather
        // than error — the POD that mattered is already stored.
        if (apiErrorCode(err) === "POD_LOCKED") {
          setReview(null);
          await reconcile();
          return;
        }
        // Dead signal with the photo already captured: queue it and let the
        // driver carry on — a save, not a failure. The uri is made
        // reload-durable first (web blob: URLs die with the page).
        if (isNetworkError(err)) {
          try {
            const durable = await toDurablePhotoUri(photo);
            await enqueuePodItem({ tripId: trip.id, stopId: stop.id, photo: durable });
            setReview(null);
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
    });

  // Queue the Delivered intent locally (photo/K2 already merged on the item if
  // captured offline) — the background flush completes the stop.
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
      // The server would reject this delivered confirm while the POD photo is
      // still queued on the phone (DOCUMENTATION_INCOMPLETE), so don't try:
      // record the intent and let the flush run photo → ack → delivered.
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
        await removePodItem(stop.id);
        // The delivered stop stops being the target; the screen re-points.
        setFocusStopId(null);
        // Last stop delivered → pending_approval (POD-approval gate): the
        // incentive is PROPOSED, paid only once an admin approves.
        if (updated.status === "pending_approval") {
          void stopBackgroundTracking();
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
        // Delivered gates the driver's pay — never let it fail silently.
        toast(msg, "error");
      }
    });

  // ── Footer: exactly one primary action ──────────────────────────────────
  const busy = updateStatus.isPending || updateDocs.isPending;
  const footer = (() => {
    if (!activeStop || stage === null) return null;
    if (stage === "arrived") {
      return {
        meta: t("trip.stepNOfTotal", { n: 1, total: 3 }),
        node: (
          <Button
            title={t("trip.arrivedAtPickup")}
            onPress={() => onArrived(activeStop)}
            loading={busy}
            size="xl"
            icon={<Ionicons name="location" size={24} color={colors.white} />}
          />
        ),
      };
    }
    if (stage === "pod") {
      return {
        meta: t("trip.stepsDone", { done: 1, total: 3 }),
        node: (
          <Button
            title={t("trip.podCapture")}
            onPress={() => openPodCamera(activeStop)}
            loading={uploadPod.isPending}
            size="xl"
            icon={<Ionicons name="camera" size={24} color={colors.white} />}
          />
        ),
      };
    }
    if (stage === "k2") {
      return {
        meta: t("trip.stepsDone", { done: 2, total: 3 }),
        node: (
          <>
            <Button
              title={t("trip.k2Capture")}
              onPress={() => onCaptureK2(activeStop)}
              loading={uploadK2.isPending}
              size="xl"
              icon={<Ionicons name="document-attach" size={24} color={colors.white} />}
            />
            {/* Delivered is LOCKED, not dimmed — an explicit row saying why. */}
            <View style={styles.lockedRow}>
              <Ionicons name="lock-closed" size={15} color={colors.textFaint} />
              <Text style={styles.lockedText}>{t("trip.deliveredAfterK2")}</Text>
            </View>
          </>
        ),
      };
    }
    return {
      meta: t("trip.lastStepForStop"),
      node: (
        <Button
          title={t("trip.markDelivered")}
          onPress={() => onDelivered(activeStop)}
          loading={busy}
          variant="accent"
          size="xl"
          icon={<Ionicons name="checkmark" size={26} color={colors.navy} />}
        />
      ),
    };
  })();

  // Current-stop card state label: NOW once arrived, HEADING TO when the
  // driver re-pointed here, NEXT when the run advanced to it on its own.
  const arrivedHere =
    activeStop?.status === "arrived" || (activeStop ? stageFlags(activeStop).arrivedQueued === true : false);
  const stateHue = arrivedHere ? CURRENT_STOP_HUE : colors.blue;
  const stateLabel = arrivedHere
    ? t("trip.nowStopLabel", { n: activeStop?.sequence, total: bySeq.length })
    : focusStopId === activeStop?.id
      ? t("trip.headingToStopLabel", { n: activeStop?.sequence, total: bySeq.length })
      : t("trip.nextStopLabel", { n: activeStop?.sequence, total: bySeq.length });

  const deliveredSummary =
    deliveredStops.length > 0
      ? t("trip.deliveredNames", {
          count: deliveredStops.length,
          names: deliveredStops
            .map((s) => s.consignee?.company_name ?? "")
            .filter(Boolean)
            .join(", "),
        })
      : null;

  return (
    <View style={styles.fill}>
      {/* 1 ── Map band (196px). Native renders react-native-maps; the web
              build swaps in a placeholder via ActiveTripMap.web.tsx. */}
      <View style={styles.mapBand}>
        <ActiveTripMap
          region={region}
          dest={dest}
          destLabel={tripDestination(trip)}
          polyline={route?.polyline}
          current={tracking.current}
        />
        <TouchableOpacity
          style={[styles.backBtn, { top: insets.top + 8 }]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
        >
          <Ionicons name="chevron-back" size={24} color={colors.navy} />
        </TouchableOpacity>
        {trip.status === "in_progress" ? (
          <View style={[styles.badgeFloat, { top: insets.top + 16 }]}>
            <TrackingBadge tracking={tracking} onReEnable={() => setShowGpsConsent(true)} />
          </View>
        ) : null}
      </View>

      {/* 2 ── Progress header + segmented rail */}
      <View style={styles.railWrap}>
        <View style={styles.railInner}>
          <View style={styles.railHead}>
            <Text style={styles.railTitle}>
              {t("trip.stopOfTotal", {
                n: activeStop?.sequence ?? bySeq.length,
                total: bySeq.length,
                delivered: deliveredStops.length,
              })}
            </Text>
            {/* Browsers have no pull-to-refresh (RN-web renders RefreshControl
                as a plain View) — web drivers resync here. */}
            <WebRefreshButton refreshing={isRefetching} onRefresh={refetch} />
            <Text style={styles.railTicket}>{trip.ticket_number}</Text>
          </View>
          <View style={styles.rail}>
            {bySeq.map((s) => (
              <View
                key={s.id}
                style={[
                  styles.railSeg,
                  {
                    backgroundColor:
                      s.status === "delivered"
                        ? colors.green
                        : s.status === "arrived"
                          ? CURRENT_STOP_HUE
                          : s.id === activeStop?.id
                            ? colors.blue
                            : colors.border,
                  },
                ]}
              />
            ))}
          </View>
        </View>
      </View>

      {/* 3 ── Unfinished-stop banner (POD up, Delivered never tapped) */}
      {unfinished.length > 0 ? (
        <View style={styles.bannerWrap}>
          <TouchableOpacity
            style={styles.banner}
            activeOpacity={0.8}
            onPress={() => setFocusStopId(unfinished[0].id)}
            accessibilityRole="button"
          >
            <View style={styles.bannerIcon}>
              <Ionicons name="alert" size={17} color={colors.white} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.bannerTitle} numberOfLines={1}>
                {unfinished.length > 1
                  ? t("trip.unfinishedStopMany", { count: unfinished.length })
                  : t("trip.unfinishedStop", { n: unfinished[0].sequence })}
              </Text>
              <Text style={styles.bannerSub} numberOfLines={1}>
                {t("trip.unfinishedStopSub", {
                  name: unfinished[0].consignee?.company_name ?? "",
                })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={CURRENT_STOP_HUE} />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* 4 ── Scroll body */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {activeStop ? (
          <View style={styles.stopCard}>
            <View style={styles.stopCardHead}>
              <View style={styles.stateRow}>
                <View style={[styles.stateDot, { backgroundColor: stateHue }]} />
                <Text style={[styles.stateLabel, { color: stateHue }]}>{stateLabel}</Text>
              </View>
              <View style={{ flex: 1 }} />
              <View style={styles.zonePill}>
                <Text style={styles.zonePillText}>{activeStop.consignee?.zone_code ?? "—"}</Text>
              </View>
            </View>
            <Text style={styles.consigneeName}>{activeStop.consignee?.company_name ?? "—"}</Text>
            <Text style={styles.consigneeAddr}>
              {consigneeAddress(activeStop.consignee) ||
                [activeStop.consignee?.area, activeStop.consignee?.state].filter(Boolean).join(", ") ||
                "—"}
            </Text>
            {!destination.precise ? (
              <Text style={styles.approx}>{t("trip.approxLocation")}</Text>
            ) : null}

            {/* Before the POD: the full-width Maps CTA + Call / Problem.
                After it: the green POD line + three compact chips. */}
            {podDoneHere ? (
              <>
                <View style={styles.podLine}>
                  <Ionicons
                    name={podQueuedHere ? "cloud-upload-outline" : "checkmark-circle"}
                    size={19}
                    color={podQueuedHere ? colors.orange : colors.green}
                  />
                  <Text style={[styles.podLineText, podQueuedHere && { color: colors.navy }]} numberOfLines={1}>
                    {podQueuedHere
                      ? t("trip.podQueued")
                      : (activeStop.pod_uploaded_at ?? podTimes[activeStop.id])
                        ? t("trip.podUploadedAt", {
                            time: formatTime((activeStop.pod_uploaded_at ?? podTimes[activeStop.id])!),
                          })
                        : t("trip.podUploaded")}
                  </Text>
                  <TouchableOpacity
                    style={styles.retakePill}
                    onPress={() => openPodCamera(activeStop)}
                    disabled={uploadPod.isPending}
                    accessibilityRole="button"
                  >
                    <Ionicons name="camera-reverse" size={16} color={colors.blue} />
                    <Text style={styles.retakePillText}>{t("trip.podRetakeShort")}</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.chipRow}>
                  <Chip icon="navigate" label={t("trip.mapsShort")} onPress={() => openMapsFor(activeStop)} />
                  <Chip icon="call" label={t("trip.call")} onPress={() => callConsignee(activeStop)} />
                  {exceptionsEnabled() ? (
                    <Chip icon="warning-outline" label={t("trip.problemShort")} danger onPress={() => setShowReport(true)} />
                  ) : null}
                </View>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.mapsCta}
                  onPress={() => openMapsFor(activeStop)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                >
                  <Ionicons name="navigate" size={15} color={colors.blue} />
                  <Text style={styles.mapsCtaText}>{t("trip.driveInMaps")}</Text>
                  <Ionicons name="open-outline" size={13} color={colors.blue} />
                </TouchableOpacity>
                <View style={styles.chipRowWide}>
                  <Chip icon="call" label={t("trip.callConsignee")} onPress={() => callConsignee(activeStop)} grow />
                  {exceptionsEnabled() ? (
                    <Chip icon="warning-outline" label={t("trip.reportProblemBtn")} danger grow onPress={() => setShowReport(true)} />
                  ) : null}
                </View>
              </>
            )}
          </View>
        ) : null}

        {/* K2 explainer — why Delivered is locked on this stop. */}
        {stage === "k2" ? (
          <View style={styles.k2Card}>
            <View style={styles.k2Icon}>
              <Ionicons name="document-attach" size={22} color={colors.teal} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.k2Title}>{t("trip.k2StillNeeded")}</Text>
              <Text style={styles.k2Sub}>{t("trip.k2StillNeededSub")}</Text>
            </View>
          </View>
        ) : null}

        {exceptionsEnabled() && trip.status === "in_progress" ? (
          <ExceptionStatusCard tripId={trip.id} />
        ) : null}

        {/* Upcoming stops — horizontal strip; the peek IS the affordance. */}
        {upcoming.length > 0 ? (
          <View>
            <View style={styles.stripHead}>
              <Text style={styles.stripHeadLeft}>{t("trip.stopsLeftCount", { count: upcoming.length })}</Text>
              <Text style={styles.stripHeadRight}>{t("trip.anyOrder")}</Text>
            </View>
            <View>
              <ScrollView
                ref={stripRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.strip}
                onScroll={(e) => {
                  stripOffset.current = e.nativeEvent.contentOffset.x;
                }}
                scrollEventThrottle={16}
                onLayout={(e) => setStripViewport(e.nativeEvent.layout.width)}
              >
                {upcoming.map((s, i) => {
                  const tag = zoneTagColors(s.consignee?.zone_code);
                  const first = i === 0;
                  return (
                    <View key={s.id} style={[styles.stripCard, first && styles.stripCardFirst]}>
                      <View style={styles.stripTop}>
                        <View style={[styles.zoneTag, { backgroundColor: tag.bg }]}>
                          <Text style={[styles.zoneTagText, { color: tag.fg }]}>
                            {s.consignee?.zone_code ?? "—"}
                          </Text>
                        </View>
                        <Text style={styles.stripKm}>
                          {haversineKm(kmOrigin, consigneeDestination(s.consignee).coord)} {t("common.km")}
                        </Text>
                      </View>
                      <Text style={styles.stripName} numberOfLines={2}>
                        {s.consignee?.company_name ?? "—"}
                      </Text>
                      <Text style={styles.stripTown} numberOfLines={1}>
                        {s.consignee?.area ?? ""}
                      </Text>
                      <TouchableOpacity
                        style={[styles.goHere, first && styles.goHereFirst]}
                        onPress={() => setFocusStopId(s.id)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.goHereText}>{t("trip.goHere")}</Text>
                        <Ionicons name="arrow-forward" size={17} color={colors.blue} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </ScrollView>
              {stripViewport > 0 &&
              upcoming.length * STRIP_CARD_W +
                (upcoming.length - 1) * STRIP_GAP +
                STRIP_PAD * 2 >
                stripViewport + 8 ? (
                <>
                  <LinearGradient
                    colors={["rgba(244,246,251,0)", colors.bg]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.stripFade}
                    pointerEvents="none"
                  />
                  <TouchableOpacity
                    style={styles.stripPuck}
                    accessibilityRole="button"
                    accessibilityLabel={t("trip.stopsLeftCount", { count: upcoming.length })}
                    onPress={() =>
                      stripRef.current?.scrollTo({ x: stripOffset.current + 160, animated: true })
                    }
                  >
                    <Ionicons name="chevron-forward" size={22} color={colors.blue} />
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          </View>
        ) : null}

        {deliveredSummary ? (
          <View style={styles.deliveredLine}>
            <Ionicons name="checkmark-circle" size={15} color={colors.green} />
            <Text style={styles.deliveredLineText} numberOfLines={1}>
              {deliveredSummary}
            </Text>
          </View>
        ) : null}

        {/* Requestor-uploaded documents (DO / invoice) — reference material. */}
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
      </ScrollView>

      {/* 5 ── Pinned footer: exactly one primary action */}
      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.footerInner}>
            <View style={styles.footerHead}>
              <Text style={styles.footerKicker}>{t("trip.doThisNext")}</Text>
              <Text style={styles.footerMeta}>{footer.meta}</Text>
            </View>
            {footer.node}
          </View>
        </View>
      ) : null}

      {/* POD review — capture → check → upload (design screen 3) */}
      <PodReviewModal
        photo={review?.photo ?? null}
        subtitle={
          review
            ? `${t("trip.stop", { n: review.stop.sequence })} · ${review.stop.consignee?.company_name ?? ""}`
            : ""
        }
        uploading={uploadPod.isPending}
        onRetake={() => {
          const stop = review?.stop;
          setReview(null);
          if (stop) void openPodCamera(stop);
        }}
        onUse={() => void confirmPod()}
        onCancel={() => setReview(null)}
      />

      {exceptionsEnabled() && (
        <ReportExceptionSheet
          visible={showReport}
          tripId={trip.id}
          stops={bySeq.map((s) => ({
            id: s.id,
            label: t("exception.stopN", { n: s.sequence, name: s.consignee?.company_name ?? "" }),
          }))}
          // The stop he is standing at, so the sheet names it instead of
          // asking him to pick it out of a list (design frame 19).
          activeStopId={activeStop?.id ?? null}
          onClose={() => setShowReport(false)}
        />
      )}

      {/* Completion modal — re-toned per the corrected design: GREEN marks the
          delivery, and the incentive sits in its own boxed block behind an
          amber PENDING APPROVAL chip with a NAVY figure, so a held payment can
          never read as paid. Presentation only — `pending_approval` is
          unchanged server-side (the amount is still the engine's proposal). */}
      <Modal visible={earned !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="checkmark" size={36} color={colors.white} />
            </View>
            <Text style={styles.modalTitle}>
              {t("trip.allStopsDelivered", { count: (trip.stops ?? []).length })}
            </Text>
            <Text style={styles.modalSub}>{t("trip.runFinished")}</Text>
            <View style={styles.pendingBlock}>
              <View style={styles.pendingChip}>
                <Ionicons name="time-outline" size={15} color={PENDING_AMBER_TEXT} />
                <Text style={styles.pendingChipText}>{t("trip.pendingApprovalChip")}</Text>
              </View>
              <Text style={styles.pendingAmount}>{formatMoney(earned)}</Text>
              <Text style={styles.modalNote}>{t("trip.incentivePendingNote")}</Text>
            </View>
            <Button
              title={t("trip.backToDashboard")}
              size="xl"
              onPress={() => {
                setEarned(null);
                navigation.popToTop();
                navigation.getParent<BottomTabNavigationProp<DriverTabParamList>>()?.navigate("Home");
              }}
              style={{ alignSelf: "stretch", marginTop: 20 }}
            />
          </View>
        </View>
      </Modal>

      {/* GPS consent explainer — shown BEFORE the OS/browser location prompt. */}
      <Modal visible={showGpsConsent} transparent animationType="fade" onRequestClose={declineGps}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.modalIcon, { backgroundColor: colors.blue }]}>
              <Ionicons name="location" size={34} color={colors.white} />
            </View>
            <Text style={styles.modalTitle}>{t("trip.gpsConsentTitle")}</Text>
            <Text style={styles.gpsConsentBody}>{t("trip.gpsConsentBody")}</Text>
            <View style={styles.gpsPoints}>
              {[
                t("trip.gpsPointActive"),
                t("trip.gpsPointForeground"),
                t("trip.gpsPointNotification"),
                t("trip.gpsPointDispatch"),
              ].map((line) => (
                <View key={line} style={styles.gpsPointRow}>
                  <Ionicons name="checkmark-circle" size={17} color={colors.green} />
                  <Text style={styles.gpsPointText}>{line}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.gpsBatteryHint}>{t("trip.gpsBatteryHint")}</Text>
            <Button
              title={t("trip.gpsEnable")}
              size="xl"
              onPress={acceptGps}
              style={{ alignSelf: "stretch", marginTop: 18 }}
            />
            <TouchableOpacity onPress={declineGps} style={{ marginTop: 12, padding: 6 }}>
              <Text style={styles.gpsNotNow}>{t("trip.gpsNotNow")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Compact pill action on the current-stop card. 44px min target throughout.
function Chip({
  icon,
  label,
  onPress,
  danger,
  grow,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
  grow?: boolean;
}) {
  const fg = danger ? colors.red : colors.blue;
  return (
    <TouchableOpacity
      style={[styles.chip, { borderColor: danger ? colors.red : colors.border }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={grow ? 17 : 15} color={fg} />
      <Text style={[styles.chipText, { color: fg, fontSize: grow ? typeScale.sm : typeScale.xs }]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// Status chip on the map band: live / locating / offline+queued / off. When
// off (consent not given, or OS-denied) it re-opens the consent explainer.
function TrackingBadge({
  tracking,
  onReEnable,
}: {
  tracking: TripLocationState;
  onReEnable: () => void;
}) {
  const { t } = useTranslation();
  const offline = !tracking.online || tracking.queued > 0;
  const off = tracking.status === "needs_consent" || tracking.status === "denied";

  let dotColor: string = colors.green;
  let label = t("trip.live");
  if (off) {
    dotColor = colors.red;
    label = t("trip.locationOff");
  } else if (offline) {
    // Orange appears ONLY for offline/queued — the standing owner ruling.
    dotColor = colors.orange;
    label = t("trip.offlineQueued", { count: tracking.queued });
  } else if (tracking.status !== "tracking" || !tracking.current) {
    dotColor = colors.textFaint;
    label = t("trip.locating");
  }

  const inner = (
    <>
      <View style={[styles.trackDot, { backgroundColor: dotColor }]} />
      <Text style={styles.trackText}>{label}</Text>
      {off ? <Text style={styles.trackEnable}>· {t("trip.gpsTapEnable")}</Text> : null}
    </>
  );

  return off ? (
    <TouchableOpacity style={styles.trackBadge} onPress={onReEnable} activeOpacity={0.7}>
      {inner}
    </TouchableOpacity>
  ) : (
    <View style={styles.trackBadge}>{inner}</View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },

  // 1 — map band
  mapBand: { height: 196, position: "relative", backgroundColor: colors.tintBlue },
  backBtn: {
    position: "absolute",
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  badgeFloat: { position: "absolute", right: 12 },
  trackBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.white,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
    ...shadow.card,
  },
  trackDot: { width: 8, height: 8, borderRadius: 4 },
  trackText: { fontSize: typeScale.sm, fontWeight: "700", color: colors.navy },
  trackEnable: { fontSize: typeScale.sm, fontWeight: "700", color: colors.blue },

  // 2 — progress header + rail
  railWrap: { backgroundColor: colors.white, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  railInner: { width: "100%", maxWidth: layout.content, alignSelf: "center", paddingHorizontal: 16, paddingVertical: 11 },
  railHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 7 },
  railTitle: { flex: 1, fontSize: typeScale.sm, fontWeight: "800", color: colors.navy },
  railTicket: { fontSize: typeScale.xs, fontWeight: "600", color: colors.textFaint },
  rail: { flexDirection: "row", gap: 4 },
  railSeg: { flex: 1, height: 6, borderRadius: 3 },

  // 3 — unfinished-stop banner
  bannerWrap: { width: "100%", maxWidth: layout.content, alignSelf: "center", paddingHorizontal: 16, paddingTop: 12 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: CURRENT_STOP_TINT,
    borderWidth: 1.5,
    borderColor: CURRENT_STOP_HUE,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bannerIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: CURRENT_STOP_HUE,
    alignItems: "center",
    justifyContent: "center",
  },
  bannerTitle: { fontSize: typeScale.sm, fontWeight: "800", color: colors.navy },
  bannerSub: { fontSize: typeScale.xs, color: CURRENT_STOP_HUE, marginTop: 1 },

  // 4 — scroll body
  body: { width: "100%", maxWidth: layout.content, alignSelf: "center", paddingVertical: 14, gap: 12 },

  stopCard: {
    marginHorizontal: 16,
    backgroundColor: colors.white,
    borderRadius: 18,
    padding: 12,
    ...shadow.floating,
  },
  stopCardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  stateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  stateDot: { width: 9, height: 9, borderRadius: 5 },
  stateLabel: { fontSize: typeScale.xs, fontWeight: "900", letterSpacing: 0.7 },
  zonePill: { backgroundColor: colors.fieldBg, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill },
  zonePillText: { fontSize: typeScale.xs, fontWeight: "900", color: colors.navy, letterSpacing: 0.5 },
  consigneeName: { fontSize: 17, fontWeight: "800", color: colors.navy, marginTop: 10, lineHeight: 21 },
  consigneeAddr: { fontSize: typeScale.sm, color: colors.textMuted, marginTop: 4, lineHeight: 19 },
  approx: { fontSize: typeScale.xs, color: colors.textFaint, marginTop: 4 },

  mapsCta: {
    minHeight: 44,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.blue,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  mapsCtaText: { fontSize: typeScale.sm, fontWeight: "800", color: colors.blue },

  chipRow: { flexDirection: "row", gap: 6, marginTop: 8 },
  chipRowWide: { flexDirection: "row", gap: 8, marginTop: 10 },
  chip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    paddingHorizontal: 8,
  },
  chipText: { fontWeight: "700" },

  podLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: colors.tintGreen,
  },
  podLineText: { flex: 1, fontSize: typeScale.sm, fontWeight: "800", color: POD_GREEN_TEXT },
  retakePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: POD_GREEN_BORDER,
  },
  retakePillText: { fontSize: typeScale.sm, fontWeight: "800", color: colors.blue },

  k2Card: {
    marginHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: 10,
    ...shadow.card,
  },
  k2Icon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.tintTeal, alignItems: "center", justifyContent: "center" },
  k2Title: { fontSize: typeScale.md, fontWeight: "800", color: colors.navy },
  k2Sub: { fontSize: typeScale.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

  stripHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 6 },
  stripHeadLeft: { fontSize: typeScale.xs, fontWeight: "800", color: colors.grey, letterSpacing: 0.5, textTransform: "uppercase" },
  stripHeadRight: { fontSize: typeScale.xs, color: colors.textFaint },
  strip: { gap: STRIP_GAP, paddingHorizontal: STRIP_PAD },
  stripCard: {
    width: STRIP_CARD_W,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: 10,
    gap: 5,
  },
  stripCardFirst: { borderWidth: 1.5, borderColor: colors.blue },
  stripTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  zoneTag: { minWidth: 26, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  zoneTagText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.4 },
  stripKm: { fontSize: typeScale.xs, fontWeight: "700", color: colors.textFaint },
  stripName: { fontSize: typeScale.sm, fontWeight: "800", color: colors.navy, lineHeight: 17 },
  stripTown: { fontSize: typeScale.xs, color: colors.textFaint },
  goHere: {
    marginTop: "auto",
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  goHereFirst: { backgroundColor: colors.tintBlue, borderColor: colors.tintBlue },
  goHereText: { fontSize: typeScale.sm, fontWeight: "800", color: colors.blue },
  stripFade: { position: "absolute", top: 0, bottom: 0, right: 0, width: 64 },
  stripPuck: {
    position: "absolute",
    top: "50%",
    right: 10,
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },

  deliveredLine: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16 },
  deliveredLineText: { flex: 1, fontSize: typeScale.xs, fontWeight: "700", color: colors.green },

  docSection: { marginHorizontal: 16 },
  docSectionTitle: { fontSize: typeScale.md, fontWeight: "800", color: colors.navy, marginBottom: 10 },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  docName: { fontSize: typeScale.md, fontWeight: "700", color: colors.navy },
  docDate: { fontSize: typeScale.sm, color: colors.textFaint, marginTop: 2 },

  error: { color: colors.red, fontSize: typeScale.md, fontWeight: "600", marginHorizontal: 16 },

  // 5 — pinned footer
  footer: {
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingTop: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 10,
  },
  footerInner: { width: "100%", maxWidth: layout.content, alignSelf: "center", paddingHorizontal: 16 },
  footerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  footerKicker: { fontSize: typeScale.xs, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  footerMeta: { fontSize: typeScale.xs, fontWeight: "700", color: colors.grey },
  lockedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 8,
    minHeight: 32,
    borderRadius: 12,
    backgroundColor: colors.fieldBg,
  },
  lockedText: { fontSize: typeScale.sm, fontWeight: "800", color: colors.textFaint },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 32, alignItems: "center", width: "100%", maxWidth: layout.auth },
  modalIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.green, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 22, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalSub: { fontSize: typeScale.md, color: colors.textMuted, textAlign: "center", marginTop: 6 },
  modalNote: { fontSize: typeScale.sm, color: colors.textMuted, textAlign: "center", marginTop: 6, lineHeight: 18 },
  // The incentive gets its OWN block so it reads as a separate, still-open
  // matter rather than a reward banner.
  pendingBlock: {
    alignSelf: "stretch",
    marginTop: 20,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.fieldBg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  pendingChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.tintYellow,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  pendingChipText: { fontSize: typeScale.xs, fontWeight: "800", color: PENDING_AMBER_TEXT, letterSpacing: 0.3 },
  // NAVY, never green — green is "paid" everywhere else in this app.
  pendingAmount: { fontSize: typeScale.hero, fontWeight: "900", color: colors.navy, marginTop: 10, lineHeight: 46 },

  gpsConsentBody: { fontSize: 14.5, color: colors.textMuted, textAlign: "center", lineHeight: 21, marginBottom: 4 },
  gpsPoints: { alignSelf: "stretch", gap: 10, marginTop: 16 },
  gpsPointRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  gpsPointText: { flex: 1, fontSize: typeScale.md, fontWeight: "600", color: colors.navy },
  gpsBatteryHint: { alignSelf: "stretch", fontSize: typeScale.xs, color: colors.textFaint, lineHeight: 17, marginTop: 14 },
  gpsNotNow: { fontSize: typeScale.lg, fontWeight: "700", color: colors.textMuted },
});
